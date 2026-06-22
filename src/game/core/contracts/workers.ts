// T42 / §I — worker message contract. Frozen.
// Workers own heavy batch tasks; they never touch DOM/React (V/§I). Messages are discriminated
// by channel + kind and correlated by requestId. Buffers are transferred/shared, not deep-cloned.

export type WorkerChannel = 'nav' | 'world' | 'population' | 'serialization';

export interface WorkerRequestBase {
  readonly requestId: number;
  readonly channel: WorkerChannel;
}

export type WorkerRequest =
  | (WorkerRequestBase & { readonly channel: 'nav'; readonly kind: 'buildFlowField'; readonly navRevision: number; readonly targetCell: number })
  | (WorkerRequestBase & { readonly channel: 'nav'; readonly kind: 'rebuildTiles'; readonly tiles: readonly number[] })
  | (WorkerRequestBase & { readonly channel: 'world'; readonly kind: 'loadChunk'; readonly chunk: number })
  | (WorkerRequestBase & { readonly channel: 'population'; readonly kind: 'stepAbstract'; readonly seconds: number })
  | (WorkerRequestBase & { readonly channel: 'serialization'; readonly kind: 'writeCheckpoint'; readonly district: number });

export type WorkerResponse =
  | { readonly requestId: number; readonly channel: 'nav'; readonly kind: 'flowFieldReady'; readonly navRevision: number; readonly targetCell: number }
  | { readonly requestId: number; readonly channel: 'nav'; readonly kind: 'tilesRebuilt'; readonly tiles: readonly number[] }
  | { readonly requestId: number; readonly channel: 'world'; readonly kind: 'chunkLoaded'; readonly chunk: number }
  | { readonly requestId: number; readonly channel: 'population'; readonly kind: 'abstractStepped'; readonly seconds: number }
  | { readonly requestId: number; readonly channel: 'serialization'; readonly kind: 'checkpointWritten'; readonly district: number }
  | { readonly requestId: number; readonly channel: WorkerChannel; readonly kind: 'error'; readonly message: string };
