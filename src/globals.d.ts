declare const require: (specifier: string) => any;
interface AbortSignal { readonly aborted: boolean; }
declare class AbortController { signal: AbortSignal; abort(): void; }
declare function setTimeout(callback: () => void, delay: number): any;
declare function clearTimeout(timer: any): void;

declare const process: {
  env: Record<string, string | undefined>;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exitCode?: number;
  exit(code?: number): never;
};

declare const Buffer: {
  from(value: string): any;
};

declare const console: {
  log(message: string): void;
  error(message: string): void;
};
