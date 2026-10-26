export interface Options {
  verbose: boolean;
}

export type Handler = (opts: Options) => void;

export enum Mode {
  Fast,
  Slow,
}

export const run = (opts: Options): void => {
  console.log(opts);
};

export abstract class Runner {
  private readonly name: string;

  public start(opts: Options): void {
    this.name = 'x';
  }

  protected abstract stop(): void;
}
