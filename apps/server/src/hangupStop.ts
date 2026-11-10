export function stopOnHangup(): void {
  let received = false;
  process.on("SIGHUP", () => {
    if (received) return;
    received = true;
    process.kill(process.pid, "SIGTERM");
  });
}
