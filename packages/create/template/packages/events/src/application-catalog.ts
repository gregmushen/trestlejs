import { defineEventCatalog } from "./catalog.js";

// Application-owned event definitions belong here. Internal events do not
// become customer-visible until they declare an explicit webhook projection.
export const applicationEventCatalog = defineEventCatalog([]);
