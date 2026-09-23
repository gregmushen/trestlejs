import { createAuth, type AuthCapabilities, type AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { declaredCapabilities } from "@__TRESTLE_PROJECT_NAME__/platform";

import manifestText from "../../../.trestle/project.yaml";

const declared = declaredCapabilities(manifestText);

/** Authentication and enterprise identity as declared in .trestle/project.yaml. */
export const authCapabilities: AuthCapabilities = { passkeys: declared.passkeys, twoFactor: declared.twoFactor, sso: declared.sso, directory: declared.directory };

/** The customer Better Auth instance with the declared identity plugins. */
export function workerAuth(environment: AuthEnvironment) {
  return createAuth(environment, { capabilities: authCapabilities });
}
