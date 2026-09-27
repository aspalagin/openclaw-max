/**
 * MAX channel secret contract — the artifact the gateway loads before the
 * plugin runtime (`dist/secret-contract-api.js`) to resolve SecretRef options
 * and to list them for `openclaw secrets`. See src/secret-contract.ts.
 */

export {
  collectRuntimeConfigAssignments,
  maxChannelSecrets as channelSecrets,
  secretTargetRegistryEntries,
} from './src/secret-contract.js';
