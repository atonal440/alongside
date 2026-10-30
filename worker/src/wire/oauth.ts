import * as v from 'valibot';
import type { Brand } from '@shared/brand';
import { OAuthCodeSchema } from '../parse';

export type RedirectUri = Brand<string, 'RedirectUri'>;
export type OAuthClientId = Brand<string, 'OAuthClientId'>;
export type OAuthState = Brand<string, 'OAuthState'>;
export type CodeChallenge = Brand<string, 'CodeChallenge'>;
export type CodeVerifier = Brand<string, 'CodeVerifier'>;
export type CodeChallengeMethod = Brand<'S256', 'CodeChallengeMethod'>;

export const RedirectUriSchema = v.pipe(
  v.string(),
  v.check(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Expected an http(s) redirect URI.'),
  v.transform(value => value as RedirectUri),
);

export const OAuthClientIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.transform(value => value as OAuthClientId),
);

export const OAuthStateSchema = v.pipe(
  v.string(),
  v.maxLength(500),
  v.transform(value => value as OAuthState),
);

export const CodeChallengeSchema = v.pipe(
  v.string(),
  v.minLength(43),
  v.maxLength(128),
  v.transform(value => value as CodeChallenge),
);

export const CodeVerifierSchema = v.pipe(
  v.string(),
  v.minLength(43),
  v.maxLength(128),
  v.transform(value => value as CodeVerifier),
);

export const CodeChallengeMethodSchema = v.pipe(
  v.literal('S256'),
  v.transform(value => value as CodeChallengeMethod),
);

const OptionalSecret = v.optional(v.pipe(v.string(), v.maxLength(500)));

export const AuthorizationCodeGrantSchema = v.object({
  grant_type: v.literal('authorization_code'),
  code: OAuthCodeSchema,
  code_verifier: v.optional(CodeVerifierSchema),
  redirect_uri: RedirectUriSchema,
  client_id: v.optional(OAuthClientIdSchema),
  client_secret: OptionalSecret,
});

export const RefreshTokenGrantSchema = v.object({
  grant_type: v.literal('refresh_token'),
  refresh_token: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  client_id: v.optional(OAuthClientIdSchema),
  client_secret: OptionalSecret,
});

export const OAuthTokenBodySchema = v.variant('grant_type', [AuthorizationCodeGrantSchema, RefreshTokenGrantSchema]);
