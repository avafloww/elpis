//! Boot-frozen requirements and non-authoritative Linux preflight evidence.
//!
//! This crate deliberately cannot launch a process or install policy.  A positive
//! report only says that read-only observations are consistent with the one
//! compiled launcher profile.  The launcher must still perform and verify every
//! namespace, mount, credential, capability, seccomp, Landlock, and cgroup
//! operation before executing guest code.

mod filesystem;

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PROFILE_VERSION: u32 = 1;
pub const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
pub const LANDLOCK_ACCESS_FS_ALL_V5: u64 = (1 << 16) - 1;
pub const LANDLOCK_SCOPE_ALL_V6: u64 = (1 << 2) - 1;

/// The only launcher contract accepted by this crate.  It is compiled in, has
/// no deserializer, and therefore cannot be weakened by request data or config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LauncherProfile {
    pub version: u32,
    pub account_name: &'static str,
    pub group_name: &'static str,
    pub require_user_namespace: bool,
    pub require_mount_namespace: bool,
    pub require_pid_namespace: bool,
    pub require_network_namespace: bool,
    pub require_loopback_down: bool,
    pub require_no_new_privs: bool,
    pub clear_effective_permitted_inheritable: bool,
    pub clear_ambient_capabilities: bool,
    pub drop_capability_bounding_set: bool,
    pub seccomp_audit_arch: u32,
    pub seccomp_default_kill_process: bool,
    pub seccomp_reject_x32_abi: bool,
    pub minimum_landlock_abi: u32,
    pub landlock_handled_fs: u64,
    pub landlock_scoped: u64,
    pub cgroup_controllers: &'static [&'static str],
    pub cgroup_accounting_files: &'static [&'static str],
    pub require_cgroup_kill: bool,
    pub require_recursive_private_mounts: bool,
    pub required_filesystems: &'static [&'static str],
    pub require_openat2: bool,
    pub require_close_range: bool,
    pub require_pivot_root: bool,
}

pub static SENSITIVE_GUEST_PROFILE: LauncherProfile = LauncherProfile {
    version: PROFILE_VERSION,
    account_name: "elpis-sandbox",
    group_name: "elpis-sandbox",
    require_user_namespace: true,
    require_mount_namespace: true,
    require_pid_namespace: true,
    require_network_namespace: true,
    require_loopback_down: true,
    require_no_new_privs: true,
    clear_effective_permitted_inheritable: true,
    clear_ambient_capabilities: true,
    drop_capability_bounding_set: true,
    seccomp_audit_arch: AUDIT_ARCH_X86_64,
    seccomp_default_kill_process: true,
    seccomp_reject_x32_abi: true,
    minimum_landlock_abi: 6,
    landlock_handled_fs: LANDLOCK_ACCESS_FS_ALL_V5,
    landlock_scoped: LANDLOCK_SCOPE_ALL_V6,
    cgroup_controllers: &["cpu", "io", "memory", "pids"],
    cgroup_accounting_files: &[
        "cpu.stat",
        "io.stat",
        "memory.current",
        "memory.events",
        "pids.current",
        "pids.events",
    ],
    require_cgroup_kill: true,
    require_recursive_private_mounts: true,
    required_filesystems: &["proc", "tmpfs", "cgroup2"],
    require_openat2: true,
    require_close_range: true,
    require_pivot_root: true,
};

static PROFILE_CANONICAL_BYTES: OnceLock<Vec<u8>> = OnceLock::new();
static PROFILE_SHA256: OnceLock<String> = OnceLock::new();

pub fn profile_canonical_bytes() -> &'static [u8] {
    PROFILE_CANONICAL_BYTES
        .get_or_init(|| {
            serde_json::to_vec(&SENSITIVE_GUEST_PROFILE)
                .expect("the static confinement profile must serialize")
        })
        .as_slice()
}

pub fn profile_sha256() -> &'static str {
    PROFILE_SHA256
        .get_or_init(|| hex::encode(Sha256::digest(profile_canonical_bytes())))
        .as_str()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeState {
    Observed,
    Absent,
    Unreadable,
    Unsupported,
    /// A read-only observation is compatible, but enforcement was intentionally not attempted.
    NotExercised,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountEvidence {
    pub state: ProbeState,
    pub user_name: String,
    pub uid: Option<u32>,
    pub primary_gid: Option<u32>,
    pub group_name: String,
    pub gid: Option<u32>,
    pub login_disabled: bool,
    pub unique_uid: bool,
    pub unique_gid: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NamespaceEvidence {
    pub handles: BTreeSet<String>,
    pub max_user_namespaces: Option<u64>,
    pub max_mount_namespaces: Option<u64>,
    pub max_pid_namespaces: Option<u64>,
    pub max_network_namespaces: Option<u64>,
    pub unprivileged_userns_clone: Option<bool>,
    pub uid_map_readable: bool,
    pub gid_map_readable: bool,
    pub setgroups_control_readable: bool,
    /// Namespace creation and isolated mounts are setup-time operations, not preflight claims.
    pub creation: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoNewPrivilegesEvidence {
    pub prctl_supported: bool,
    pub currently_set: Option<bool>,
    pub enforcement: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CapabilityEvidence {
    pub capget_supported: bool,
    pub ambient_query_supported: bool,
    pub last_cap: Option<u32>,
    pub bounding_set_readable_through_last_cap: bool,
    pub currently_bounded: Vec<u32>,
    pub status_sets_readable: bool,
    pub clearing: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SeccompEvidence {
    pub machine: Option<String>,
    pub actions_available: BTreeSet<String>,
    pub action_query_supported: bool,
    pub filter_api_supported: bool,
    pub current_mode: Option<u32>,
    pub filter_installation: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LandlockEvidence {
    pub abi: Option<u32>,
    pub active_lsms: BTreeSet<String>,
    pub ruleset_installation: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CgroupEvidence {
    pub unified_v2: bool,
    pub current_path: Option<PathBuf>,
    pub controllers: BTreeSet<String>,
    pub subtree_control: BTreeSet<String>,
    pub resident_pids: Vec<u32>,
    pub directory_writable: bool,
    pub procs_writable: bool,
    pub subtree_control_writable: bool,
    pub cgroup_kill_present: bool,
    pub cgroup_kill_writable: bool,
    pub accounting_files: BTreeSet<String>,
    pub child_creation_and_kill: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MountEvidence {
    pub root_mount_found: bool,
    pub root_is_private: bool,
    pub mountinfo_readable: bool,
    pub mount_api_supported: bool,
    pub recursive_private_remount: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FilesystemEvidence {
    pub filesystems: BTreeSet<String>,
    pub proc_self_fd: bool,
    pub proc_self_mountinfo: bool,
    pub openat2_syscall: bool,
    pub close_range_syscall: bool,
    pub pivot_root_syscall: bool,
    pub mount_setup: ProbeState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostEvidence {
    pub linux: bool,
    pub account: AccountEvidence,
    pub namespaces: NamespaceEvidence,
    pub no_new_privileges: NoNewPrivilegesEvidence,
    pub capabilities: CapabilityEvidence,
    pub seccomp: SeccompEvidence,
    pub landlock: LandlockEvidence,
    pub cgroup: CgroupEvidence,
    pub mounts: MountEvidence,
    pub filesystems: FilesystemEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "primitive", content = "detail", rename_all = "snake_case")]
pub enum MissingPrimitive {
    Linux,
    ArchitectureX86_64,
    DedicatedUser,
    DedicatedGroup,
    DedicatedAccountIsolation,
    UserNamespace,
    MountNamespace,
    PidNamespace,
    NetworkNamespace,
    NoNewPrivileges,
    CapabilityBoundingSet,
    CapabilitySets,
    AmbientCapabilities,
    CapabilityStatus,
    SeccompAction(String),
    SeccompFilter,
    LandlockAbi {
        required: u32,
        observed: Option<u32>,
    },
    LandlockLsmActive,
    CgroupV2,
    CgroupController(String),
    CgroupSubtreeController(String),
    CgroupDelegationWritable,
    CgroupExclusiveLeaf,
    CgroupKill,
    CgroupAccounting(String),
    PrivateMountPropagation,
    Filesystem(String),
    ProcSelfFd,
    Openat2,
    CloseRange,
    PivotRoot,
    ProbeUnreadable(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AvailabilityReport {
    profile_version: u32,
    evidence: HostEvidence,
    missing: Vec<MissingPrimitive>,
}

impl AvailabilityReport {
    pub fn profile_version(&self) -> u32 {
        self.profile_version
    }

    pub fn evidence(&self) -> &HostEvidence {
        &self.evidence
    }

    pub fn missing(&self) -> &[MissingPrimitive] {
        &self.missing
    }

    pub fn is_available(&self) -> bool {
        self.missing.is_empty()
    }

    pub fn require_available(&self) -> Result<&HostEvidence, Unavailable> {
        if self.is_available() {
            Ok(&self.evidence)
        } else {
            Err(Unavailable {
                missing: self.missing.clone(),
            })
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("sensitive guest confinement is unavailable: {missing:?}")]
pub struct Unavailable {
    pub missing: Vec<MissingPrimitive>,
}

static BOOT_PREFLIGHT: OnceLock<AvailabilityReport> = OnceLock::new();

/// Capture once per process.  Subsequent calls return the boot-frozen evidence;
/// they do not silently accept host changes made after the first check.
pub fn boot_preflight() -> &'static AvailabilityReport {
    BOOT_PREFLIGHT.get_or_init(probe)
}

/// Perform the side-effect-free host inventory.  No namespace, cgroup, mount,
/// ruleset, filter, credential, or process is created or modified.
pub fn probe() -> AvailabilityReport {
    let account = probe_account(
        SENSITIVE_GUEST_PROFILE.account_name,
        SENSITIVE_GUEST_PROFILE.group_name,
    );
    let namespaces = probe_namespaces();
    let no_new_privileges = probe_no_new_privileges();
    let capabilities = probe_capabilities();
    let seccomp = probe_seccomp();
    let landlock = probe_landlock();
    let cgroup = probe_cgroup();
    let mounts = probe_mounts();
    let filesystems = probe_filesystems();
    let evidence = HostEvidence {
        linux: cfg!(target_os = "linux"),
        account,
        namespaces,
        no_new_privileges,
        capabilities,
        seccomp,
        landlock,
        cgroup,
        mounts,
        filesystems,
    };
    let missing = missing_for(&evidence);
    AvailabilityReport {
        profile_version: PROFILE_VERSION,
        evidence,
        missing,
    }
}

fn missing_for(e: &HostEvidence) -> Vec<MissingPrimitive> {
    let mut m = BTreeSet::new();
    if !e.linux {
        m.insert(MissingPrimitive::Linux);
    }
    if e.seccomp.machine.as_deref() != Some("x86_64") {
        m.insert(MissingPrimitive::ArchitectureX86_64);
    }
    if e.account.state == ProbeState::Unreadable {
        m.insert(MissingPrimitive::ProbeUnreadable(
            "/etc/passwd or /etc/group".into(),
        ));
    }
    if e.account.uid.is_none() {
        m.insert(MissingPrimitive::DedicatedUser);
    }
    if e.account.gid.is_none() {
        m.insert(MissingPrimitive::DedicatedGroup);
    }
    if e.account.uid.is_some()
        && e.account.gid.is_some()
        && (e.account.uid == Some(0)
            || e.account.gid == Some(0)
            || e.account.primary_gid != e.account.gid
            || !e.account.login_disabled
            || !e.account.unique_uid
            || !e.account.unique_gid)
    {
        m.insert(MissingPrimitive::DedicatedAccountIsolation);
    }
    for (name, missing) in [
        ("user", MissingPrimitive::UserNamespace),
        ("mnt", MissingPrimitive::MountNamespace),
        ("pid", MissingPrimitive::PidNamespace),
        ("net", MissingPrimitive::NetworkNamespace),
    ] {
        if !e.namespaces.handles.contains(name) {
            m.insert(missing);
        }
    }
    if e.namespaces.max_user_namespaces == Some(0)
        || e.namespaces.max_user_namespaces.is_none()
        || e.namespaces.unprivileged_userns_clone != Some(true)
        || !e.namespaces.uid_map_readable
        || !e.namespaces.gid_map_readable
        || !e.namespaces.setgroups_control_readable
    {
        m.insert(MissingPrimitive::UserNamespace);
    }
    if e.namespaces.max_mount_namespaces.unwrap_or(0) == 0 {
        m.insert(MissingPrimitive::MountNamespace);
    }
    if e.namespaces.max_pid_namespaces.unwrap_or(0) == 0 {
        m.insert(MissingPrimitive::PidNamespace);
    }
    if e.namespaces.max_network_namespaces.unwrap_or(0) == 0 {
        m.insert(MissingPrimitive::NetworkNamespace);
    }
    if !e.no_new_privileges.prctl_supported {
        m.insert(MissingPrimitive::NoNewPrivileges);
    }
    if !e.capabilities.bounding_set_readable_through_last_cap {
        m.insert(MissingPrimitive::CapabilityBoundingSet);
    }
    if !e.capabilities.capget_supported {
        m.insert(MissingPrimitive::CapabilitySets);
    }
    if !e.capabilities.ambient_query_supported {
        m.insert(MissingPrimitive::AmbientCapabilities);
    }
    if !e.capabilities.status_sets_readable {
        m.insert(MissingPrimitive::CapabilityStatus);
    }
    for action in ["allow", "errno", "kill_process"] {
        if !e.seccomp.actions_available.contains(action) {
            m.insert(MissingPrimitive::SeccompAction(action.into()));
        }
    }
    if !e.seccomp.action_query_supported || !e.seccomp.filter_api_supported {
        m.insert(MissingPrimitive::SeccompFilter);
    }
    if e.landlock.abi.unwrap_or(0) < SENSITIVE_GUEST_PROFILE.minimum_landlock_abi {
        m.insert(MissingPrimitive::LandlockAbi {
            required: SENSITIVE_GUEST_PROFILE.minimum_landlock_abi,
            observed: e.landlock.abi,
        });
    }
    if !e.landlock.active_lsms.contains("landlock") {
        m.insert(MissingPrimitive::LandlockLsmActive);
    }
    if !e.cgroup.unified_v2 {
        m.insert(MissingPrimitive::CgroupV2);
    }
    for controller in SENSITIVE_GUEST_PROFILE.cgroup_controllers {
        if !e.cgroup.controllers.contains(*controller) {
            m.insert(MissingPrimitive::CgroupController((*controller).into()));
        }
        if !e.cgroup.subtree_control.contains(*controller) {
            m.insert(MissingPrimitive::CgroupSubtreeController(
                (*controller).into(),
            ));
        }
    }
    if !e.cgroup.directory_writable
        || !e.cgroup.procs_writable
        || !e.cgroup.subtree_control_writable
    {
        m.insert(MissingPrimitive::CgroupDelegationWritable);
    }
    if e.cgroup.resident_pids.len() > 1 {
        m.insert(MissingPrimitive::CgroupExclusiveLeaf);
    }
    if !e.cgroup.cgroup_kill_present || !e.cgroup.cgroup_kill_writable {
        m.insert(MissingPrimitive::CgroupKill);
    }
    for file in SENSITIVE_GUEST_PROFILE.cgroup_accounting_files {
        if !e.cgroup.accounting_files.contains(*file) {
            m.insert(MissingPrimitive::CgroupAccounting((*file).into()));
        }
    }
    if !e.mounts.mountinfo_readable {
        m.insert(MissingPrimitive::ProbeUnreadable(
            "/proc/self/mountinfo".into(),
        ));
    }
    if !e.mounts.mount_api_supported {
        m.insert(MissingPrimitive::PrivateMountPropagation);
    }
    for filesystem in SENSITIVE_GUEST_PROFILE.required_filesystems {
        if !e.filesystems.filesystems.contains(*filesystem) {
            m.insert(MissingPrimitive::Filesystem((*filesystem).into()));
        }
    }
    if !e.filesystems.proc_self_fd {
        m.insert(MissingPrimitive::ProcSelfFd);
    }
    if !e.filesystems.openat2_syscall {
        m.insert(MissingPrimitive::Openat2);
    }
    if !e.filesystems.close_range_syscall {
        m.insert(MissingPrimitive::CloseRange);
    }
    if !e.filesystems.pivot_root_syscall {
        m.insert(MissingPrimitive::PivotRoot);
    }
    m.into_iter().collect()
}

#[derive(Debug)]
struct PasswdEntry {
    name: String,
    uid: u32,
    gid: u32,
    shell: String,
}
#[derive(Debug)]
struct GroupEntry {
    name: String,
    gid: u32,
}

fn probe_account(name: &str, group_name: &str) -> AccountEvidence {
    let passwd_result = read_passwd("/etc/passwd");
    let group_result = read_group("/etc/group");
    let unreadable = passwd_result.is_err() || group_result.is_err();
    let passwd = passwd_result.unwrap_or_default();
    let groups = group_result.unwrap_or_default();
    let user = passwd.iter().find(|p| p.name == name);
    let group = groups.iter().find(|g| g.name == group_name);
    let uid = user.map(|p| p.uid);
    let gid = group.map(|g| g.gid);
    let primary_gid = user.map(|p| p.gid);
    let login_disabled =
        user.is_some_and(|p| p.shell.ends_with("/nologin") || p.shell.ends_with("/false"));
    let unique_uid = uid.is_some_and(|id| passwd.iter().filter(|p| p.uid == id).count() == 1);
    let unique_gid = gid.is_some_and(|id| groups.iter().filter(|g| g.gid == id).count() == 1);
    let state = if unreadable {
        ProbeState::Unreadable
    } else if user.is_some() && group.is_some() {
        ProbeState::Observed
    } else {
        ProbeState::Absent
    };
    AccountEvidence {
        state,
        user_name: name.into(),
        uid,
        primary_gid,
        group_name: group_name.into(),
        gid,
        login_disabled,
        unique_uid,
        unique_gid,
    }
}

fn read_passwd(path: &str) -> io::Result<Vec<PasswdEntry>> {
    Ok(fs::read_to_string(path)?
        .lines()
        .filter_map(|line| {
            let p: Vec<_> = line.split(':').collect();
            if p.len() != 7 {
                return None;
            }
            Some(PasswdEntry {
                name: p[0].into(),
                uid: p[2].parse().ok()?,
                gid: p[3].parse().ok()?,
                shell: p[6].into(),
            })
        })
        .collect())
}
fn read_group(path: &str) -> io::Result<Vec<GroupEntry>> {
    Ok(fs::read_to_string(path)?
        .lines()
        .filter_map(|line| {
            let p: Vec<_> = line.split(':').collect();
            if p.len() != 4 {
                return None;
            }
            Some(GroupEntry {
                name: p[0].into(),
                gid: p[2].parse().ok()?,
            })
        })
        .collect())
}

fn probe_namespaces() -> NamespaceEvidence {
    let mut handles = BTreeSet::new();
    for name in ["user", "mnt", "pid", "net"] {
        if is_namespace_handle(&format!("/proc/self/ns/{name}")) {
            handles.insert(name.into());
        }
    }
    NamespaceEvidence {
        handles,
        max_user_namespaces: read_trimmed("/proc/sys/user/max_user_namespaces")
            .and_then(|s| s.parse().ok()),
        max_mount_namespaces: read_trimmed("/proc/sys/user/max_mnt_namespaces")
            .and_then(|s| s.parse().ok()),
        max_pid_namespaces: read_trimmed("/proc/sys/user/max_pid_namespaces")
            .and_then(|s| s.parse().ok()),
        max_network_namespaces: read_trimmed("/proc/sys/user/max_net_namespaces")
            .and_then(|s| s.parse().ok()),
        unprivileged_userns_clone: match read_trimmed("/proc/sys/kernel/unprivileged_userns_clone")
        {
            Some(s) => s.parse::<u32>().ok().map(|v| v != 0),
            None => None,
        },
        uid_map_readable: fs::File::open("/proc/self/uid_map").is_ok(),
        gid_map_readable: fs::File::open("/proc/self/gid_map").is_ok(),
        setgroups_control_readable: fs::File::open("/proc/self/setgroups").is_ok(),
        creation: ProbeState::NotExercised,
    }
}

fn is_namespace_handle(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|m| m.file_type().is_file()) || fs::read_link(path).is_ok()
}

fn probe_no_new_privileges() -> NoNewPrivilegesEvidence {
    // SAFETY: PR_GET_NO_NEW_PRIVS reads one integer process attribute and has no pointer arguments.
    let result = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
    NoNewPrivilegesEvidence {
        prctl_supported: result >= 0,
        currently_set: (result >= 0).then_some(result != 0),
        enforcement: ProbeState::NotExercised,
    }
}

fn probe_capabilities() -> CapabilityEvidence {
    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CapData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    let mut header = CapHeader {
        version: 0x2008_0522,
        pid: 0,
    };
    let mut data = [CapData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    // SAFETY: capget only writes the two correctly-sized V3 data records.
    let capget_supported = unsafe {
        libc::syscall(
            libc::SYS_capget,
            &mut header as *mut CapHeader,
            data.as_mut_ptr(),
        )
    } == 0;
    // SAFETY: PR_CAP_AMBIENT_IS_SET is a read-only query for capability zero.
    let ambient_query_supported =
        unsafe { libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_IS_SET, 0, 0, 0) } >= 0;
    let last_cap =
        read_trimmed("/proc/sys/kernel/cap_last_cap").and_then(|s| s.parse::<u32>().ok());
    let mut currently_bounded = Vec::new();
    let mut readable = last_cap.is_some();
    if let Some(last) = last_cap {
        for cap in 0..=last {
            // SAFETY: PR_CAPBSET_READ is a read-only integer query.
            let result =
                unsafe { libc::prctl(libc::PR_CAPBSET_READ, cap as libc::c_ulong, 0, 0, 0) };
            if result < 0 {
                readable = false;
                break;
            }
            if result == 1 {
                currently_bounded.push(cap);
            }
        }
    }
    let status = read_trimmed("/proc/self/status");
    let status_sets_readable = status.as_deref().is_some_and(|s| {
        ["CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"]
            .iter()
            .all(|prefix| s.lines().any(|l| l.starts_with(prefix)))
    });
    CapabilityEvidence {
        capget_supported,
        ambient_query_supported,
        last_cap,
        bounding_set_readable_through_last_cap: readable,
        currently_bounded,
        status_sets_readable,
        clearing: ProbeState::NotExercised,
    }
}

fn probe_seccomp() -> SeccompEvidence {
    let mut actions_available = BTreeSet::new();
    let mut action_query_supported = true;
    for (name, action) in [
        ("kill_process", 0x8000_0000u32),
        ("errno", 0x0005_0000),
        ("allow", 0x7fff_0000),
    ] {
        let mut action = action;
        // SAFETY: GET_ACTION_AVAIL only reads the pointed-to u32.
        let result =
            unsafe { libc::syscall(libc::SYS_seccomp, 2u32, 0u32, &mut action as *mut u32) };
        if result == 0 {
            actions_available.insert(name.into());
        } else if io::Error::last_os_error().raw_os_error() == Some(libc::ENOSYS) {
            action_query_supported = false;
        }
    }
    // A null filter cannot be installed. EFAULT/EACCES/EPERM show that FILTER mode was
    // recognized; EINVAL means this kernel did not accept filter mode.
    // SAFETY: the null program guarantees that no filter can be attached.
    let filter_result = unsafe {
        libc::syscall(
            libc::SYS_seccomp,
            1u32,
            0u32,
            std::ptr::null::<libc::c_void>(),
        )
    };
    let filter_errno = (filter_result < 0)
        .then(|| io::Error::last_os_error().raw_os_error())
        .flatten();
    let filter_api_supported = filter_result == 0
        || matches!(
            filter_errno,
            Some(libc::EFAULT) | Some(libc::EACCES) | Some(libc::EPERM)
        );
    let machine = read_trimmed("/proc/sys/kernel/arch").or_else(|| uname_machine().ok());
    let current_mode = read_trimmed("/proc/self/status").and_then(|s| {
        s.lines().find_map(|l| {
            l.strip_prefix("Seccomp:")
                .and_then(|v| v.trim().parse().ok())
        })
    });
    SeccompEvidence {
        machine,
        actions_available,
        action_query_supported,
        filter_api_supported,
        current_mode,
        filter_installation: ProbeState::NotExercised,
    }
}

fn uname_machine() -> io::Result<String> {
    let mut uts = std::mem::MaybeUninit::<libc::utsname>::zeroed();
    // SAFETY: uname initializes the supplied utsname structure.
    if unsafe { libc::uname(uts.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful uname provides a NUL-terminated machine array.
    let uts = unsafe { uts.assume_init() };
    let bytes: Vec<u8> = uts
        .machine
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn probe_landlock() -> LandlockEvidence {
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    // SAFETY: VERSION requires a null attribute and does not create a ruleset.
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    let abi = (result >= 0).then_some(result as u32);
    let active_lsms = read_trimmed("/sys/kernel/security/lsm")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    LandlockEvidence {
        abi,
        active_lsms,
        ruleset_installation: ProbeState::NotExercised,
    }
}

fn probe_cgroup() -> CgroupEvidence {
    let relative = fs::read_to_string("/proc/self/cgroup").ok().and_then(|s| {
        s.lines()
            .find_map(|l| l.strip_prefix("0::"))
            .map(str::trim)
            .map(String::from)
    });
    let base = Path::new("/sys/fs/cgroup");
    let current_path = relative
        .as_deref()
        .map(|r| base.join(r.trim_start_matches('/')));
    let dir = current_path.as_deref().unwrap_or(base);
    let unified_v2 = statfs_type(base) == Some(libc::CGROUP2_SUPER_MAGIC as libc::c_long);
    let controllers = words(dir.join("cgroup.controllers"));
    let subtree_control = words(dir.join("cgroup.subtree_control"))
        .into_iter()
        .map(|s| s.trim_start_matches('+').to_owned())
        .collect();
    let resident_pids = read_trimmed(dir.join("cgroup.procs"))
        .unwrap_or_default()
        .lines()
        .filter_map(|v| v.parse().ok())
        .collect();
    let cgroup_kill = dir.join("cgroup.kill");
    let accounting_files = SENSITIVE_GUEST_PROFILE
        .cgroup_accounting_files
        .iter()
        .filter(|name| dir.join(name).is_file())
        .map(|s| (*s).into())
        .collect();
    CgroupEvidence {
        unified_v2,
        current_path: current_path.clone(),
        controllers,
        subtree_control,
        resident_pids,
        directory_writable: mode_writable(dir),
        procs_writable: mode_writable(&dir.join("cgroup.procs")),
        subtree_control_writable: mode_writable(&dir.join("cgroup.subtree_control")),
        cgroup_kill_present: cgroup_kill.exists(),
        cgroup_kill_writable: mode_writable(&cgroup_kill),
        accounting_files,
        child_creation_and_kill: ProbeState::NotExercised,
    }
}

fn mode_writable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    // Root's DAC bypass does not imply a delegated cgroup. Require an explicit owner/group/other bit.
    let mode = meta.permissions().mode();
    // SAFETY: credential getters only inspect the calling process.
    let euid = unsafe { libc::geteuid() };
    if euid == 0 {
        return false;
    } // broad root is not accepted as delegation evidence.
    if euid == meta.uid() {
        return mode & 0o200 != 0;
    }
    // SAFETY: a null buffer asks getgroups for the required length.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    let in_group = if count < 0 {
        false
    } else {
        let mut groups = vec![0 as libc::gid_t; count as usize];
        // SAFETY: the vector has exactly the capacity reported by getgroups.
        let got = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        let egid = unsafe { libc::getegid() };
        egid == meta.gid() || (got >= 0 && groups[..got as usize].contains(&meta.gid()))
    };
    if in_group {
        mode & 0o020 != 0
    } else {
        mode & 0o002 != 0
    }
}
fn statfs_type(path: &Path) -> Option<libc::c_long> {
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let mut s = std::mem::MaybeUninit::<libc::statfs>::zeroed(); // SAFETY: statfs writes the supplied structure and does not mutate the filesystem.
    if unsafe { libc::statfs(c.as_ptr(), s.as_mut_ptr()) } != 0 {
        None
    } else {
        Some(unsafe { s.assume_init() }.f_type as libc::c_long)
    }
}

fn probe_mounts() -> MountEvidence {
    let content = fs::read_to_string("/proc/self/mountinfo");
    let mut root_mount_found = false;
    let mut root_is_private = false;
    if let Ok(text) = &content {
        for line in text.lines() {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.get(4) == Some(&"/") {
                root_mount_found = true;
                let dash = fields
                    .iter()
                    .position(|v| *v == "-")
                    .unwrap_or(fields.len());
                root_is_private = !fields[6..dash].iter().any(|v| {
                    v.starts_with("shared:") || v.starts_with("master:") || *v == "unbindable"
                });
                break;
            }
        }
    }
    MountEvidence {
        root_mount_found,
        root_is_private,
        mountinfo_readable: content.is_ok(),
        mount_api_supported: syscall_recognized(libc::SYS_mount),
        recursive_private_remount: ProbeState::NotExercised,
    }
}

fn probe_filesystems() -> FilesystemEvidence {
    let filesystems = fs::read_to_string("/proc/filesystems")
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_whitespace().last())
        .map(String::from)
        .collect();
    FilesystemEvidence {
        filesystems,
        proc_self_fd: fs::read_dir("/proc/self/fd").is_ok(),
        proc_self_mountinfo: fs::File::open("/proc/self/mountinfo").is_ok(),
        openat2_syscall: syscall_recognized(libc::SYS_openat2),
        close_range_syscall: syscall_recognized(libc::SYS_close_range),
        pivot_root_syscall: syscall_recognized(libc::SYS_pivot_root),
        mount_setup: ProbeState::NotExercised,
    }
}

fn syscall_recognized(number: libc::c_long) -> bool {
    // SAFETY: these deliberately invalid null/negative arguments cannot perform an operation.
    let result = unsafe {
        libc::syscall(
            number,
            -1i32,
            std::ptr::null::<libc::c_void>(),
            std::ptr::null::<libc::c_void>(),
            0usize,
        )
    };
    result >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ENOSYS)
}

fn words(path: impl AsRef<Path>) -> BTreeSet<String> {
    read_trimmed(path)
        .unwrap_or_default()
        .split_whitespace()
        .map(|s| s.trim_start_matches('+').to_owned())
        .collect()
}
fn read_trimmed(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_exact_and_boot_frozen() {
        const GOLDEN: &str = r#"{"version":1,"account_name":"elpis-sandbox","group_name":"elpis-sandbox","require_user_namespace":true,"require_mount_namespace":true,"require_pid_namespace":true,"require_network_namespace":true,"require_loopback_down":true,"require_no_new_privs":true,"clear_effective_permitted_inheritable":true,"clear_ambient_capabilities":true,"drop_capability_bounding_set":true,"seccomp_audit_arch":3221225534,"seccomp_default_kill_process":true,"seccomp_reject_x32_abi":true,"minimum_landlock_abi":6,"landlock_handled_fs":65535,"landlock_scoped":3,"cgroup_controllers":["cpu","io","memory","pids"],"cgroup_accounting_files":["cpu.stat","io.stat","memory.current","memory.events","pids.current","pids.events"],"require_cgroup_kill":true,"require_recursive_private_mounts":true,"required_filesystems":["proc","tmpfs","cgroup2"],"require_openat2":true,"require_close_range":true,"require_pivot_root":true}"#;
        const GOLDEN_SHA256: &str =
            "75a06c256533498fe53fbb9ac53ff6e7268abe4542b7a4da672e7335f799b98a";

        assert_eq!(SENSITIVE_GUEST_PROFILE.version, 1);
        assert_eq!(profile_canonical_bytes(), GOLDEN.as_bytes());
        assert_eq!(profile_sha256(), GOLDEN_SHA256);
        assert!(std::ptr::eq(boot_preflight(), boot_preflight()));
    }

    #[test]
    fn positive_evidence_never_claims_setup_was_enforced() {
        let report = probe();
        assert_eq!(
            report.evidence.namespaces.creation,
            ProbeState::NotExercised
        );
        assert_eq!(
            report.evidence.seccomp.filter_installation,
            ProbeState::NotExercised
        );
        assert_eq!(
            report.evidence.landlock.ruleset_installation,
            ProbeState::NotExercised
        );
        assert_eq!(
            report.evidence.cgroup.child_creation_and_kill,
            ProbeState::NotExercised
        );
        assert_eq!(
            report.evidence.mounts.recursive_private_remount,
            ProbeState::NotExercised
        );
    }

    #[test]
    fn absent_dedicated_account_fails_closed() {
        let mut evidence = probe().evidence().clone();
        evidence.account.uid = None;
        evidence.account.gid = None;
        let missing = missing_for(&evidence);
        assert!(missing.contains(&MissingPrimitive::DedicatedUser));
        assert!(missing.contains(&MissingPrimitive::DedicatedGroup));
        assert!(!missing.contains(&MissingPrimitive::DedicatedAccountIsolation));
    }

    #[test]
    fn nondelegated_cgroup_fails_closed() {
        let mut evidence = probe().evidence().clone();
        evidence.cgroup.subtree_control.clear();
        evidence.cgroup.directory_writable = false;
        let missing = missing_for(&evidence);
        assert!(missing.contains(&MissingPrimitive::CgroupSubtreeController("cpu".into())));
        assert!(missing.contains(&MissingPrimitive::CgroupDelegationWritable));
    }
}
