# Stop retrying exhausted provider usage limits

Provider 429 responses that explicitly report an exhausted plan, quota, or usage window now stop the current turn after one request. The blocked input remains in history for a later explicit retry, and repeated limit failures no longer contribute to the malformed-history `/clear` warning.

Ordinary transient rate-limit 429 responses remain eligible for the existing bounded retry policy. Chat, Responses, and Codex Responses Lite share one usage-limit code classifier.

Validation covers classifier edge cases, Chat streaming, Responses failure events, and the Agent retry loop. After deployment, the next genuine exhausted-subscription response should produce one capacity notice rather than the exponential retry sequence.
