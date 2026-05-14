export enum IntegrationStatus {
  Pending = 'pending',
  Active = 'active',
  Failed = 'failed',
  SchemaGap = 'schema_gap',
}

export const INTEGRATION_STATUS_VALUES = Object.values(IntegrationStatus);
