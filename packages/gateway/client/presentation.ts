import { GatewayClientError } from './api.js';

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Convert API failures to a finite set of body-free presentation messages. */
export function gatewayErrorMessage(error: unknown): string {
  if (!(error instanceof GatewayClientError))
    return 'The Gateway could not complete this action.';
  switch (error.stableCode) {
    case 'invalid_request':
      return 'The request was not accepted. Check the entered value.';
    case 'request_failed':
      return 'The Gateway could not be reached. The action was not retried.';
    case 'invalid_response':
      return 'The Gateway returned an invalid response.';
    case 'setup_required':
      return 'Gateway setup must be completed first.';
    case 'setup_complete':
    case 'setup_already_complete':
      return 'Gateway setup was already completed. Refresh the state.';
    case 'csrf_invalid':
    case 'invalid_csrf':
    case 'csrf_required':
      return 'Request authorization was not accepted. The action was not retried.';
    case 'not_found':
      return 'The requested Gateway resource was not found.';
    case 'conflict':
      return 'Gateway state changed. Refresh before trying again.';
    case 'rate_limited':
      return 'Too many requests were made. Wait before trying again.';
    case 'internal_error':
      return 'The Gateway could not complete this action.';
    default:
      if (error.status === 409)
        return 'Gateway state changed. Refresh before trying again.';
      if (error.status === 429)
        return 'Too many requests were made. Wait before trying again.';
      if (error.status >= 500)
        return 'The Gateway could not complete this action.';
      return 'The Gateway rejected the request.';
  }
}

export function setupDefaultOrigin(origin: string): string {
  return origin;
}

export function shortenPublicId(value: string): string {
  if (value.length <= 18) return value;
  return value.slice(0, 10) + '…' + value.slice(-6);
}

export function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? dateTime.format(date)
    : 'Unavailable';
}

/** A bounded countdown: it never displays negative or unbounded precision. */
export function formatExpiryCountdown(expiresAt: number, now: number): string {
  const remaining = Math.max(0, expiresAt - now);
  if (remaining === 0) return 'Expired';
  if (remaining > 86_400_000) return 'Expires in more than 24h';
  const seconds = Math.ceil(remaining / 1000);
  if (seconds < 60) return 'Expires in ' + seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const tail = seconds % 60;
  if (minutes < 60)
    return 'Expires in ' + minutes + 'm' + (tail === 0 ? '' : ' ' + tail + 's');
  const hours = Math.floor(minutes / 60);
  const minuteTail = minutes % 60;
  return (
    'Expires in ' +
    hours +
    'h' +
    (minuteTail === 0 ? '' : ' ' + minuteTail + 'm')
  );
}
