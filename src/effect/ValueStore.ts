import { Effect, Context, Option, Layer, Ref, Console } from "effect";
import localforage from "localforage";

export function Tag<T>(id: string) {
  return class extends Context.Tag(id)<
    unknown,
    {
      get: Effect.Effect<Option.Option<T>>;
      set: (value: T) => Effect.Effect<void>;
      unset: Effect.Effect<void>;
    }
  >() {};
}

export const IndexedDB = <T>(Service: ReturnType<typeof Tag<T>>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => localforage.setDriver(localforage.INDEXEDDB));
    const service: Context.Tag.Service<ReturnType<typeof Tag<T>>> = {
      get: Effect.promise(() => localforage.getItem<T>(Service._tag)).pipe(Effect.map(Option.fromNullable)),
      set: (value: T) => Effect.promise(() => localforage.setItem<T>(Service._tag, value)),
      unset: Effect.promise(() => localforage.removeItem(Service._tag)),
    };
    return service;
  });

export const Memory = <T>(Service: ReturnType<typeof Tag<T>>) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.none<T>());
    const service: Context.Tag.Service<ReturnType<typeof Tag<T>>> = {
      get: Ref.get(ref),
      set: (value: T) => Ref.set(ref, Option.some(value)),
      unset: Ref.set(ref, Option.none()),
    };
    return service;
  });
