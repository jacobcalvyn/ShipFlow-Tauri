declare module "qrcode" {
  type ToDataUrlOptions = {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    width?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  };

  const QRCode: {
    toDataURL(value: string, options?: ToDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
