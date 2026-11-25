import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REALM = "Walters-MCP-Server";

/** Constant-time string comparison (hashing first so differing lengths don't leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * HTTP Basic authentication (RFC 7617) against one configured username/password.
 * Microsoft's gateway-routed custom connectors only support No auth / Basic /
 * Windows auth, which is why Basic is used rather than an API key header.
 */
export function basicAuth(username: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (header && /^basic /i.test(header)) {
      let decoded = "";
      try {
        decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      } catch {
        /* fall through to 401 */
      }
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        const userOk = safeEqual(decoded.slice(0, idx), username);
        const passOk = safeEqual(decoded.slice(idx + 1), password);
        if (userOk && passOk) {
          next();
          return;
        }
      }
    }
    res.setHeader("WWW-Authenticate", `Basic realm="${REALM}"`);
    res.status(401).json({ error: "Unauthorized" });
  };
}
