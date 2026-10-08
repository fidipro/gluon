/**
 * How much longer waits, test timeouts and the deadlines a test's own steps must meet are: 3 on Windows, where a
 * compiled exe (the fakes) takes ~0.5 s to start, more under load; 1 elsewhere. GLUON_TEST_SLOW overrides it (CI sets
 * it: a loaded 2–4 vCPU runner is several times slower than a developer's machine). Never a bare millisecond bound.
 */
export const SLOW = Number(process.env.GLUON_TEST_SLOW) || (process.platform === "win32" ? 3 : 1);
