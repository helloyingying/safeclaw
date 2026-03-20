import type { ResourceScope } from "../../types.ts";

export interface ResourceContext {
  resourceScope: ResourceScope;
  resourcePaths: string[];
}

export interface ToolContext {
  inferredToolName?: string;
  toolGroup?: string;
  operation?: string;
  resourceScope: ResourceScope;
  resourcePaths: string[];
  tags: string[];
}

export interface DestinationContext {
  destinationType?: "internal" | "public" | "unknown" | "personal_storage" | "paste_service";
  destDomain?: string;
  destIpClass?: "loopback" | "private" | "public" | "unknown";
}

export interface LabelContext {
  assetLabels: string[];
  dataLabels: string[];
}

export interface VolumeContext {
  fileCount?: number;
  bytes?: number;
  recordCount?: number;
}
