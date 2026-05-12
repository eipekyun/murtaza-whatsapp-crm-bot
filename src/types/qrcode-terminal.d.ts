declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }

  const qrcode: {
    generate(input: string, options?: GenerateOptions, callback?: (output: string) => void): void;
  };

  export default qrcode;
}
