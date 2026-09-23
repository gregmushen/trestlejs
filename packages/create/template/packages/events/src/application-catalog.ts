import { z } from "zod";

import { defineEvent, defineEventCatalog } from "./catalog.js";

// Application-owned event definitions belong here. Internal events do not
// become customer-visible until they declare an explicit webhook projection.
// trestle:resource-event-definitions
export const applicationEventCatalog = defineEventCatalog([
  // trestle:resource-event-list
]);
