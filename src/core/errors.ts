/**
 * Typed error hierarchy. Every thrown error in Exempclaw should be (or extend)
 * an ExempclawError so the runtime can distinguish recoverable failures
 * (rate limits, connector outages) from programming errors.
 */

export class ExempclawError extends Error {
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.retryable = options.retryable ?? false;
  }
}

/** A required config value was missing or malformed. */
export class ConfigError extends ExempclawError {}

/** A connector (email, Slack, …) failed to reach its upstream service. */
export class ConnectorError extends ExempclawError {
  readonly connector: string;
  constructor(connector: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(`[${connector}] ${message}`, options);
    this.connector = connector;
  }
}

/** A tool threw while executing. Carried back into the agent loop as a tool_result error. */
export class ToolExecutionError extends ExempclawError {
  readonly tool: string;
  constructor(tool: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(`tool "${tool}" failed: ${message}`, options);
    this.tool = tool;
  }
}

/** A human (or policy) denied an outward action. Not an error condition the model can retry. */
export class ActionDeniedError extends ExempclawError {
  constructor(message: string) {
    super(message, { retryable: false });
  }
}
