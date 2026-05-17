export function shouldReconnectAfterClose(statusCode: number | undefined): boolean {
  if (statusCode === 401) return false;
  return true;
}
