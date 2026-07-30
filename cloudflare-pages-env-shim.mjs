let runtimeEnvironment = {};

export const env = new Proxy(
  {},
  {
    get(_target, property) {
      return runtimeEnvironment[property];
    },
  },
);

export function setRuntimeEnvironment(nextEnvironment) {
  runtimeEnvironment = nextEnvironment;
}
