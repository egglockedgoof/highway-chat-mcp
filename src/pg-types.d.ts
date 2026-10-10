declare module "pg" {
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(sql: string): Promise<unknown>;
    on(event: "notification" | "error", fn: (arg: unknown) => void): void;
    end(): Promise<void>;
  }
}
