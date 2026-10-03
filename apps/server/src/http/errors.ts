import { ERROR_HTTP_STATUS, type ApiErrorBody, type ErrorCode } from '@enchanted/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from '../config.js';

/**
 * An expected failure with a stable code. `message` is shown to people (in-world copy is chosen by the
 * client from the code); `detail` is a curated technical hint: never a path, SQL or a stack trace.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly statusCode: number;
  /** When set, the response carries `Retry-After` (seconds): a client that is refused for now is told how long to wait. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    detail?: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail;
    this.statusCode = ERROR_HTTP_STATUS[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Set on the upload route. Only there does a 413 or 415 mean "the file is too large / not a PDF"; on any
     * other route the same statuses are about the request body.
     */
    upload?: boolean;
  }
}

interface ClientErrorMapping {
  code: ErrorCode;
  message: string;
  /** The status of the response. */
  status: number;
}

const MULTIPART_LIMIT_ERRORS: Record<string, string> = {
  FST_REQ_FILE_TOO_LARGE: 'The uploaded file is larger than the maximum upload size.',
  FST_FILES_LIMIT: 'Too many files were uploaded; send exactly one PDF.',
  FST_PARTS_LIMIT: 'The upload has too many parts; send exactly one PDF.',
  FST_FIELDS_LIMIT: 'The upload has too many form fields; send exactly one PDF.',
};

/** A framework error that means exactly what a contract code means: the response uses that code's status (global E). */
const asContract = (code: ErrorCode, message: string): ClientErrorMapping => ({
  code,
  message,
  status: ERROR_HTTP_STATUS[code],
});

/** A framework error the contract has no matching code for: the code is a label, the status stays what the error carried. */
const carried = (code: ErrorCode, message: string, status: number): ClientErrorMapping => ({
  code,
  message,
  status,
});

/**
 * Maps errors raised by Fastify itself and its plugins (parsing, limits, rate limiting) onto API codes.
 *  - Where the error means what a contract code means, the response has that code AND its status from
 *    ERROR_HTTP_STATUS, whatever status the framework carried (the multipart plugin says 406 for a request
 *    that is not multipart; the contract says FILE_MISSING is 400).
 *  - Where it does not (a 405, a 408, a 413 on a route that is not an upload), the response keeps the status
 *    the error carried, with the nearest code as a label.
 * Codes about a file (FILE_*) are used only where a file is involved: the multipart plugin's own errors, and
 * 413/415 on the route marked `upload`.
 */
function mapClientError(error: FastifyError, isUploadRoute: boolean): ClientErrorMapping | null {
  const status = error.statusCode;
  if (status === undefined || status < 400 || status >= 500) return null;
  // Plain errors have no code at runtime, whatever the FastifyError type says.
  const code = error.code as string | undefined;
  const limit = code === undefined ? undefined : MULTIPART_LIMIT_ERRORS[code];
  if (limit !== undefined) return asContract('FILE_TOO_LARGE', limit);
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    return asContract('FILE_MISSING', 'Send the PDF as multipart/form-data in a field named "file".');
  }
  // A form field declared as JSON that is not (the plugin says 406): the upload has no usable file part.
  if (code === 'FST_INVALID_JSON_FIELD_ERROR') {
    return asContract(
      'FILE_MISSING',
      'A form field of the upload is not valid; send only the PDF, in a field named "file".',
    );
  }
  // A path parameter over the router's length limit (a document id is 36 characters): nothing can be at that address.
  if (code === 'FST_ERR_MAX_PARAM_LENGTH') {
    return asContract('DOCUMENT_NOT_FOUND', 'There is nothing at this address.');
  }
  switch (status) {
    case 400:
      return asContract('QUESTION_INVALID', 'The request could not be understood.');
    case 404:
      return asContract('DOCUMENT_NOT_FOUND', 'There is nothing at this address.');
    case 413:
      return isUploadRoute
        ? asContract('FILE_TOO_LARGE', 'The request body is too large.')
        : carried('QUESTION_INVALID', 'The request body is too large.', status);
    case 415:
      return isUploadRoute
        ? asContract('FILE_NOT_PDF', 'Unsupported content type.')
        : carried('QUESTION_INVALID', 'Unsupported content type.', status);
    case 429:
      return asContract('RATE_LIMITED', 'Too many requests. Wait a moment and try again.');
    default:
      // 401, 403, 405, 408, 409 ...: the contract has no code for them, so the status says what happened.
      return carried('INTERNAL', 'The request was refused.', status);
  }
}

function zodDetail(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  const where = issue.path.map(String).join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

function toBody(
  error: unknown,
  config: Config,
  isUploadRoute: boolean,
): { status: number; body: ApiErrorBody } {
  if (error instanceof AppError) {
    const detail = error.detail === undefined ? {} : { detail: error.detail };
    return {
      status: error.statusCode,
      body: { error: { code: error.code, message: error.message, ...detail } },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: ERROR_HTTP_STATUS.QUESTION_INVALID,
      body: {
        error: { code: 'QUESTION_INVALID', message: 'The request is not valid.', detail: zodDetail(error) },
      },
    };
  }
  const fastifyError = error as FastifyError;
  const mapped =
    typeof error === 'object' && error !== null ? mapClientError(fastifyError, isUploadRoute) : null;
  if (mapped) {
    return {
      status: mapped.status,
      body: {
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(config.isProduction ? {} : { detail: fastifyError.message }),
        },
      },
    };
  }
  // Unknown failure. The stack goes to the log only; production responses carry no detail at all.
  return {
    status: ERROR_HTTP_STATUS.INTERNAL,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'The server hit an unexpected error.',
        ...(config.isProduction || !(error instanceof Error) ? {} : { detail: error.message }),
      },
    },
  };
}

function isUploadRoute(request: FastifyRequest): boolean {
  // Errors raised before routing (a malformed URL) have a request without a route.
  const config = (request.routeOptions as { config?: { upload?: boolean } } | undefined)?.config;
  return config?.upload === true;
}

/** Sends `error` as an ApiErrorSchema body with the matching status. Usable from any handler. */
export function sendError(reply: FastifyReply, error: unknown, config: Config): FastifyReply {
  const { status, body } = toBody(error, config, isUploadRoute(reply.request));
  if (error instanceof AppError && error.retryAfterSeconds !== undefined) {
    void reply.header('retry-after', error.retryAfterSeconds);
  }
  return reply.status(status).send(body);
}

/** The 404 response for an unknown route. The contract has no dedicated code, so DOCUMENT_NOT_FOUND carries it. */
export function sendNotFound(request: FastifyRequest, reply: FastifyReply, config: Config): FastifyReply {
  const path = request.url.split('?')[0] ?? '';
  return sendError(
    reply,
    new AppError('DOCUMENT_NOT_FOUND', 'There is nothing at this address.', `${request.method} ${path}`),
    config,
  );
}

/** Produces the response for a request no route matched. */
export type NotFoundHandler = (request: FastifyRequest, reply: FastifyReply) => unknown;

/**
 * Installs the error handler and the 404 handler. Every error response has the ApiErrorSchema shape.
 * `onNotFound` lets production serving replace the 404 body with the SPA shell for non-API routes.
 */
export function registerErrorHandling(
  app: FastifyInstance,
  config: Config,
  onNotFound: NotFoundHandler = (request, reply) => sendNotFound(request, reply, config),
): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const { status } = toBody(error, config, isUploadRoute(request));
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.debug({ err: error }, 'request rejected');
    }
    return sendError(reply, error, config);
  });

  app.setNotFoundHandler((request, reply) => onNotFound(request, reply));
}
