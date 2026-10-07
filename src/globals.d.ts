declare const require: (specifier: string) => any;

declare const process: {
  env: Record<string, string | undefined>;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exitCode?: number;
};

declare const Buffer: {
  from(value: string): any;
};

declare const console: {
  log(message: string): void;
  error(message: string): void;
};
