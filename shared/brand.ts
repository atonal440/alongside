declare const BRAND: unique symbol;

export type Brand<T, K extends string> = T & { readonly [BRAND]: { readonly [P in K]: true } };

export function unsafeBrand<T, K extends string>(value: T): Brand<T, K> {
  return value as Brand<T, K>;
}
