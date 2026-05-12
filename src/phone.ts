export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');

  if (digits.startsWith('00')) {
    return digits.slice(2);
  }

  if (digits.length === 10 && digits.startsWith('5')) {
    return `90${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return `90${digits.slice(1)}`;
  }

  return digits;
}

export function normalizeWhitelist(phones: string[]): Set<string> {
  return new Set(phones.map(normalizePhone).filter(Boolean));
}
