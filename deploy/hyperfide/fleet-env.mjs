const aliases = Object.freeze({
  BL_API_KEY: 'BLAXEL_API_KEY',
  BL_WORKSPACE: 'BLAXEL_WORKSPACE',
  HF_BLAXEL_API_KEY: 'BLAXEL_API_KEY',
  HF_BLAXEL_WORKSPACE: 'BLAXEL_WORKSPACE',
  HF_RAILWAY_API_TOKEN: 'RAILWAY_API_TOKEN',
  RAILWAY_ENVIRONMENT_ID: 'RAILWAY_ENVIREMENT_ID',
  HF_ARTIFACT_S3_ENDPOINT: 'HF_ARTIFACT_S3_URL',
  HF_ARTIFACT_S3_ACCESS_KEY_ID: 'HF_ARTIFACT_S3_ACCESS_KEY',
  HF_ARTIFACT_S3_SECRET_ACCESS_KEY: 'HF_ARTIFACT_S3_SECRET_KEY',
});

export function applyFleetEnvironment(env = process.env) {
  for (const [canonical, alias] of Object.entries(aliases)) {
    if (!Object.hasOwn(env, canonical) && typeof env[alias] === 'string') env[canonical] = env[alias];
  }
  return env;
}

applyFleetEnvironment();
