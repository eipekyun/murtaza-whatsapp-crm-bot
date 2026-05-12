export function shouldReconnectAfterClose(statusCode: number | undefined): boolean {
  if (statusCode === 401) return false;
  if (statusCode === 408) return false;
  return true;
}
