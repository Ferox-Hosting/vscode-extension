// Directory entry as returned by our panel's client file API (see
// FileRepository::getDirectoryRaw). The legacy Node daemon does not expose the
// richer Wings fields (mode_bits, size_physical, inner_editable, …), so we only
// carry what the FileSystemProvider actually needs.
export interface DirectoryEntry {
  name: string;
  directory: boolean;
  file: boolean;
  symlink: boolean;
  size: number;
  mime: string;
  modified: string | null;
}

// Our panel returns the whole directory in a single, unpaginated payload.
export interface DirectoryListResponse {
  entries: DirectoryEntry[];
}

export interface Server {
  uuid: string;
  uuid_short: string;
  name: string;
  description: string | null;
  suspended: boolean;
}

// Pterodactyl 0.7.x wraps every resource in a Fractal envelope. A single
// resource is `{ object, attributes }`; a collection is `{ object: 'list',
// data: [...], meta: { pagination } }`.
export interface FractalItem<T> {
  object: string;
  attributes: T;
}

export interface FractalPagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

export interface FractalList<T> {
  object: 'list';
  data: FractalItem<T>[];
  meta?: { pagination?: FractalPagination };
}

// Raw attributes for a server as produced by the panel's client ServerTransformer.
export interface ServerAttributes {
  server_owner: boolean;
  identifier: string;
  uuid: string;
  name: string;
  description: string | null;
  // Emitted by the panel's client ServerTransformer. Optional so the extension
  // still tolerates an older panel build that predates the field (treated as
  // not suspended).
  suspended?: boolean;
}

export interface WebsocketCredentials {
  token: string;
  url: string;
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export type PowerState = 'offline' | 'starting' | 'running' | 'stopping';

export interface ResourceUsage {
  memory_bytes: number;
  memory_limit_bytes: number;
  disk_bytes: number;
  state: PowerState;
  network: { rx_bytes: number; tx_bytes: number };
  cpu_absolute: number;
  uptime: number;
}

export interface PublicSettings {
  app: {
    name: string;
  };
  server: {
    max_file_manager_view_size: number;
    max_file_manager_content_search_size: number;
    max_file_manager_search_results: number;
    container_prelude: string;
  };
}

export interface FileSearchFilters {
  root: string;
  path_filter: { include: string[]; exclude: string[]; case_insensitive: boolean } | null;
  size_filter: { min: number; max: number } | null;
  content_filter: {
    query: string;
    max_search_size: number;
    include_unmatched: boolean;
    case_insensitive: boolean;
  } | null;
}
