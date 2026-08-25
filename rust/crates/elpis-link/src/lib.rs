use std::io;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use elpis_identity::IdentityStore;
use elpis_journal::{
    ClientHeartbeatOutcome, HeartbeatOutcome, Journal, PrepareOutcome, RequestStatus,
};
use elpis_protocol::{MAX_FRAME_BYTES, Request, Response};
use elpis_transport::{ClientHello, ExecutorFence, FenceCheckpoint, ServerFrame, ServerWelcome};
use thiserror::Error;
use tungstenite::http::Uri;
use tungstenite::protocol::{Message, WebSocketConfig};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Connector, WebSocket, client_tls_with_config};

mod supervisor;
pub use supervisor::{
    BackoffPolicy, DrainSignal, Supervisor, SupervisorConfig, SupervisorError, SupervisorExit,
};

const MAX_ENDPOINT_BYTES: usize = 2048;
const MAX_TIMEOUT: Duration = Duration::from_secs(300);
const READ_BUFFER_BYTES: usize = 16 * 1024;
const WRITE_OVERHEAD_BYTES: usize = 16 * 1024;
const MAX_HANDSHAKE_CONTROL_MESSAGES: usize = 16;

type LinkSocket = WebSocket<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkConfig {
    endpoint: String,
    host: String,
    port: u16,
    connect_timeout: Duration,
    io_timeout: Duration,
}

impl LinkConfig {
    pub fn new(
        endpoint: impl Into<String>,
        identity: &IdentityStore,
        connect_timeout: Duration,
        io_timeout: Duration,
    ) -> Result<Self, LinkError> {
        let endpoint = endpoint.into();
        if endpoint.is_empty() || endpoint.len() > MAX_ENDPOINT_BYTES {
            return Err(LinkError::InvalidConfiguration);
        }
        let uri: Uri = endpoint
            .parse()
            .map_err(|_| LinkError::InvalidConfiguration)?;
        if uri.scheme_str() != Some("wss")
            || uri.authority().is_none()
            || uri
                .authority()
                .is_some_and(|authority| authority.as_str().contains('@'))
            || uri
                .path_and_query()
                .is_some_and(|value| value.query().is_some())
        {
            return Err(LinkError::InvalidConfiguration);
        }
        let host = uri.host().ok_or(LinkError::InvalidConfiguration)?;
        if !host.eq_ignore_ascii_case(identity.tls_server_name()) {
            return Err(LinkError::InvalidConfiguration);
        }
        let port = uri.port_u16().unwrap_or(443);
        if connect_timeout.is_zero()
            || io_timeout.is_zero()
            || connect_timeout > MAX_TIMEOUT
            || io_timeout > MAX_TIMEOUT
        {
            return Err(LinkError::InvalidConfiguration);
        }
        Ok(Self {
            endpoint,
            host: host.to_ascii_lowercase(),
            port,
            connect_timeout,
            io_timeout,
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn connect_timeout(&self) -> Duration {
        self.connect_timeout
    }

    pub fn io_timeout(&self) -> Duration {
        self.io_timeout
    }
}

pub trait Dispatcher {
    fn dispatch(&mut self, request: Request) -> Response;
}

impl<F> Dispatcher for F
where
    F: FnMut(Request) -> Response,
{
    fn dispatch(&mut self, request: Request) -> Response {
        self(request)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Idle,
    Control,
    ServerHeartbeat { server_seq: u64 },
    RequestCompleted { server_seq: u64 },
    CompletedResponseResent { server_seq: u64 },
    Closed,
}

pub struct Session {
    socket: LinkSocket,
    fence: ExecutorFence,
}

impl Session {
    pub fn connect(
        config: &LinkConfig,
        identity: &IdentityStore,
        journal: &Journal,
        boot_epoch: &str,
    ) -> Result<Self, LinkError> {
        let metadata = identity.metadata();
        let state = journal.state().map_err(|_| LinkError::Journal)?;
        if state
            .executor_id
            .as_deref()
            .is_some_and(|value| value != metadata.executor_id)
            || state
                .boot_epoch
                .as_deref()
                .is_some_and(|value| value != boot_epoch)
        {
            return Err(LinkError::Journal);
        }
        let hello = ClientHello::new(
            metadata.executor_id,
            boot_epoch,
            state.last_committed_server_seq,
        )
        .map_err(|_| LinkError::Protocol)?;
        let client_config = identity.client_config().map_err(|_| LinkError::Identity)?;
        let tcp = connect_tcp(config)?;
        let connector = Connector::Rustls(client_config);
        let websocket = WebSocketConfig::default()
            .read_buffer_size(READ_BUFFER_BYTES)
            .write_buffer_size(0)
            .max_write_buffer_size(MAX_FRAME_BYTES + WRITE_OVERHEAD_BYTES)
            .max_message_size(Some(MAX_FRAME_BYTES))
            .max_frame_size(Some(MAX_FRAME_BYTES));
        let (mut socket, _) =
            client_tls_with_config(config.endpoint(), tcp, Some(websocket), Some(connector))
                .map_err(|_| LinkError::Handshake)?;
        socket
            .send(Message::binary(
                hello.to_json().map_err(|_| LinkError::Protocol)?,
            ))
            .map_err(map_socket_error)?;
        let welcome_bytes = read_handshake_payload(&mut socket)?;
        let welcome = ServerWelcome::from_json(&welcome_bytes).map_err(|_| LinkError::Protocol)?;
        let connection_id = match &welcome {
            ServerWelcome::Welcome { connection_id, .. } => connection_id.clone(),
        };
        welcome
            .validate_for(&hello)
            .map_err(|_| LinkError::Protocol)?;
        let checkpoint = journal
            .fence_checkpoint(hello.executor_id(), hello.boot_epoch(), &connection_id)
            .map_err(|_| LinkError::Journal)?;
        let fence = ExecutorFence::restore(checkpoint).map_err(|_| LinkError::Journal)?;
        Ok(Self { socket, fence })
    }

    pub fn step(
        &mut self,
        journal: &mut Journal,
        dispatcher: &mut impl Dispatcher,
    ) -> Result<SessionEvent, LinkError> {
        let message = match self.socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error)) if is_timeout(&error) => {
                return Ok(SessionEvent::Idle);
            }
            Err(tungstenite::Error::ConnectionClosed) => return Ok(SessionEvent::Closed),
            Err(_) => return Err(LinkError::Transport),
        };
        let bytes = match message {
            Message::Binary(bytes) => bytes,
            Message::Text(text) => text.into(),
            Message::Ping(_) | Message::Pong(_) => {
                self.socket.flush().map_err(map_socket_error)?;
                return Ok(SessionEvent::Control);
            }
            Message::Close(_) => {
                self.socket.flush().map_err(map_socket_error)?;
                return Ok(SessionEvent::Closed);
            }
            Message::Frame(_) => return Err(LinkError::Protocol),
        };
        let frame = ServerFrame::from_json(&bytes).map_err(|_| LinkError::Protocol)?;
        let server_seq = server_sequence(&frame);
        if server_seq < self.fence.next_server_seq() {
            return self.handle_existing(journal, &frame, server_seq);
        }
        let dispatched = self
            .fence
            .accept_server_frame(frame.clone())
            .map_err(|_| LinkError::Fence)?;
        match &frame {
            ServerFrame::Heartbeat { .. } => {
                if dispatched.is_some() {
                    return Err(LinkError::StateMismatch);
                }
                if journal
                    .commit_heartbeat(&frame)
                    .map_err(|_| LinkError::Journal)?
                    != HeartbeatOutcome::New
                {
                    return Err(LinkError::StateMismatch);
                }
                Ok(SessionEvent::ServerHeartbeat { server_seq })
            }
            ServerFrame::Request { .. } => {
                let prepared = match journal.prepare(&frame).map_err(|_| LinkError::Journal)? {
                    PrepareOutcome::New(prepared) => prepared,
                    PrepareOutcome::Existing(_) => return Err(LinkError::StateMismatch),
                };
                let dispatched = dispatched.ok_or(LinkError::StateMismatch)?;
                let response = dispatcher.dispatch(dispatched.request);
                let response_frame = self
                    .fence
                    .build_response(dispatched.seq, response)
                    .map_err(|_| LinkError::Fence)?;
                let stored = journal
                    .complete(&prepared, &response_frame)
                    .map_err(|_| LinkError::Journal)?;
                self.send_exact(stored.bytes)?;
                Ok(SessionEvent::RequestCompleted { server_seq })
            }
        }
    }

    pub fn send_heartbeat(&mut self, journal: &mut Journal) -> Result<(), LinkError> {
        let frame = self.fence.build_heartbeat().map_err(|_| LinkError::Fence)?;
        if journal
            .commit_client_heartbeat(&frame)
            .map_err(|_| LinkError::Journal)?
            != ClientHeartbeatOutcome::New
        {
            return Err(LinkError::StateMismatch);
        }
        self.send_exact(frame.to_json().map_err(|_| LinkError::Protocol)?)
    }

    pub fn close(&mut self) -> Result<(), LinkError> {
        self.socket.close(None).map_err(map_socket_error)
    }

    pub fn checkpoint(&self) -> FenceCheckpoint {
        self.fence.checkpoint()
    }

    fn handle_existing(
        &mut self,
        journal: &mut Journal,
        frame: &ServerFrame,
        server_seq: u64,
    ) -> Result<SessionEvent, LinkError> {
        match frame {
            ServerFrame::Heartbeat { .. } => {
                if journal
                    .commit_heartbeat(frame)
                    .map_err(|_| LinkError::Journal)?
                    != HeartbeatOutcome::Existing
                {
                    return Err(LinkError::StateMismatch);
                }
                Ok(SessionEvent::ServerHeartbeat { server_seq })
            }
            ServerFrame::Request { .. } => {
                let stored = match journal.prepare(frame).map_err(|_| LinkError::Journal)? {
                    PrepareOutcome::Existing(stored) => stored,
                    PrepareOutcome::New(_) => return Err(LinkError::StateMismatch),
                };
                match stored.status {
                    RequestStatus::Completed => {
                        let response = stored.response.ok_or(LinkError::StateMismatch)?;
                        self.send_exact(response.bytes)?;
                        Ok(SessionEvent::CompletedResponseResent { server_seq })
                    }
                    RequestStatus::Prepared | RequestStatus::Ambiguous => {
                        Err(LinkError::UncertainRequest(server_seq))
                    }
                }
            }
        }
    }

    fn send_exact(&mut self, bytes: Vec<u8>) -> Result<(), LinkError> {
        self.socket
            .send(Message::binary(bytes))
            .map_err(map_socket_error)
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LinkError {
    #[error("invalid link configuration")]
    InvalidConfiguration,
    #[error("endpoint resolution failed")]
    Resolution,
    #[error("endpoint connection failed")]
    Connection,
    #[error("identity credentials are unavailable")]
    Identity,
    #[error("TLS or WebSocket handshake failed")]
    Handshake,
    #[error("transport protocol violation")]
    Protocol,
    #[error("durable journal rejected the operation")]
    Journal,
    #[error("sequence fence rejected the operation")]
    Fence,
    #[error("network transport failed")]
    Transport,
    #[error("request sequence {0} has uncertain effect outcome")]
    UncertainRequest(u64),
    #[error("session and durable state disagree")]
    StateMismatch,
}

fn connect_tcp(config: &LinkConfig) -> Result<TcpStream, LinkError> {
    let started = Instant::now();
    let addresses = resolve_bounded(config.host.clone(), config.port, config.connect_timeout)?;
    let mut stream = None;
    for address in addresses {
        let remaining = config
            .connect_timeout
            .checked_sub(started.elapsed())
            .ok_or(LinkError::Connection)?;
        if remaining.is_zero() {
            return Err(LinkError::Connection);
        }
        if let Ok(candidate) = TcpStream::connect_timeout(&address, remaining) {
            stream = Some(candidate);
            break;
        }
    }
    let stream = stream.ok_or(LinkError::Connection)?;
    stream
        .set_read_timeout(Some(config.io_timeout))
        .map_err(|_| LinkError::Connection)?;
    stream
        .set_write_timeout(Some(config.io_timeout))
        .map_err(|_| LinkError::Connection)?;
    stream
        .set_nodelay(true)
        .map_err(|_| LinkError::Connection)?;
    Ok(stream)
}

fn resolve_bounded(
    host: String,
    port: u16,
    timeout: Duration,
) -> Result<Vec<SocketAddr>, LinkError> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("elpis-link-resolver".into())
        .spawn(move || {
            let result = (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect::<Vec<_>>());
            let _ = sender.send(result);
        })
        .map_err(|_| LinkError::Resolution)?;
    let addresses = receiver
        .recv_timeout(timeout)
        .map_err(|_| LinkError::Resolution)?
        .map_err(|_| LinkError::Resolution)?;
    if addresses.is_empty() {
        return Err(LinkError::Resolution);
    }
    Ok(addresses)
}

fn read_handshake_payload(socket: &mut LinkSocket) -> Result<Vec<u8>, LinkError> {
    for _ in 0..MAX_HANDSHAKE_CONTROL_MESSAGES {
        match socket.read() {
            Ok(Message::Binary(bytes)) => return Ok(bytes.to_vec()),
            Ok(Message::Text(text)) => return Ok(text.as_bytes().to_vec()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {
                socket.flush().map_err(map_socket_error)?;
            }
            Ok(Message::Close(_) | Message::Frame(_)) => return Err(LinkError::Handshake),
            Err(_) => return Err(LinkError::Handshake),
        }
    }
    Err(LinkError::Handshake)
}

fn server_sequence(frame: &ServerFrame) -> u64 {
    match frame {
        ServerFrame::Request { seq, .. } | ServerFrame::Heartbeat { seq, .. } => *seq,
    }
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

fn map_socket_error(_: tungstenite::Error) -> LinkError {
    LinkError::Transport
}
