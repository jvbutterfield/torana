// Injection marker — prefixed to inject-path prompts so the runner sees
// a clear boundary between torana-generated framing and caller-supplied
// text. The security posture is that inject callers are already trusted
// (bearer token), so this is framing, not sanitization.
//
// See tasks/impl-agent-api.md §6.4 + §12.5.

export function wrapInjected(text: string, source: string): string {
  return `[system-injected from "${source}"]\n\n${text}`;
}
