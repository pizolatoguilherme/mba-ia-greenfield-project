/**
 * Mock type for unit tests: every method of `T` becomes a `jest.Mock` property.
 *
 * Unlike `jest.Mocked<T>`, the members are typed as properties (not methods),
 * so assertions such as `expect(service.method).toHaveBeenCalled()` do not
 * trip `@typescript-eslint/unbound-method`, while arguments and return types
 * stay checked (`mockResolvedValue` keeps the method's resolved type).
 */
export type MockedMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? jest.Mock<R, A>
    : T[K];
};
