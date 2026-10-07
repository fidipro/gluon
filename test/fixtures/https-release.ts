/**
 * A local release server for the installers' https tests (test/docker/https.sh, test/install-ps1.ps1):
 * never the network. Serves the files of RELEASE_DIR over https and over plain http:
 *
 *   https://localhost:$HTTPS_PORT/r/<file>          the file
 *   https://localhost:$HTTPS_PORT/to-https/<file>   302 → https://localhost:$HTTPS_PORT/r/<file> (as GitHub → its CDN)
 *   https://localhost:$HTTPS_PORT/to-http/<file>    302 → http://127.0.0.1:$HTTP_PORT/r/<file> (must be refused)
 *   http://127.0.0.1:$HTTP_PORT/r/<file>            the file; each request is appended to HTTP_LOG
 *
 * TLS_CERT / TLS_KEY: a self-signed certificate for localhost. HOST: where to listen (default 127.0.0.1).
 * Prints "ready" when both listen.
 */
import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};
const dir = env("RELEASE_DIR");
const httpsPort = Number(env("HTTPS_PORT", "8443"));
const httpPort = Number(env("HTTP_PORT", "8080"));
const hostname = env("HOST", "127.0.0.1");
const httpLog = env("HTTP_LOG", "");

async function file(path: string): Promise<Response> {
  const f = Bun.file(join(dir, basename(path)));
  return (await f.exists()) ? new Response(f) : new Response("not found\n", { status: 404 });
}

Bun.serve({
  hostname,
  port: httpsPort,
  tls: { cert: Bun.file(env("TLS_CERT")), key: Bun.file(env("TLS_KEY")) },
  fetch(req) {
    const { pathname } = new URL(req.url);
    const [, route, name = ""] = pathname.split("/");
    if (route === "r") return file(name);
    if (route === "to-https") return Response.redirect(`https://localhost:${httpsPort}/r/${name}`, 302);
    if (route === "to-http") return Response.redirect(`http://127.0.0.1:${httpPort}/r/${name}`, 302);
    return new Response("not found\n", { status: 404 });
  },
});

Bun.serve({
  hostname,
  port: httpPort,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (httpLog) appendFileSync(httpLog, `${pathname}\n`);
    return pathname.startsWith("/r/") ? file(pathname.slice(3)) : new Response("not found\n", { status: 404 });
  },
});

console.log("ready");
