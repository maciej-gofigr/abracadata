import { useEffect, useRef, useState } from "react";
import { authRequest, authVerify } from "../lib/api";

/** Passwordless sign-in: email -> 6-digit code -> verified.
 * In dev the backend echoes the code (AUTH_DEV_ECHO); we surface it so the
 * flow is usable locally without a real mailer. */
export function AuthModal({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: (email: string) => void | Promise<void>;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function sendCode() {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authRequest(email.trim());
      setDevCode(r.dev_code);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authVerify(email.trim(), code.trim());
      await onSignedIn(r.email ?? email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2 className="modal-title">Sign in</h2>
        <p className="modal-sub">Keep your recipes and reach them from any device. No password — we email you a code.</p>

        {step === "email" ? (
          <>
            <label className="field-label" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              ref={firstField}
              className="field"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendCode()}
            />
            {error && <div className="field-error">{error}</div>}
            <button className="btn primary modal-action" disabled={busy || !email.trim()} onClick={sendCode}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="auth-code">
              Enter the 6-digit code sent to <b>{email.trim()}</b>
            </label>
            <input
              id="auth-code"
              ref={firstField}
              className="field code-field"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && verify()}
            />
            {devCode && (
              <div className="dev-code">Dev mode — your code is <b>{devCode}</b></div>
            )}
            {error && <div className="field-error">{error}</div>}
            <button className="btn primary modal-action" disabled={busy || code.length < 6} onClick={verify}>
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
            <button className="linklike modal-back" onClick={() => { setStep("email"); setCode(""); setError(null); }}>
              Use a different email
            </button>
          </>
        )}
      </div>
    </div>
  );
}
