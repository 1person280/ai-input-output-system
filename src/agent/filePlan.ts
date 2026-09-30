/**
 * 领域层：自主创建文件的领域类型与校验。
 *
 * 纯类型 + 少量纯函数，不依赖 vscode，可在纯 Node 进程下单测。
 */

/** 计划的来源：本地模型 / 云端模型 / 离线启发式降级。 */
export type PlanSource = 'local' | 'cloud' | 'heuristic';

/** 单个待创建文件：相对路径 + 文本内容。 */
export interface PlannedFile {
  path: string;
  content: string;
}

/** 一次自主创建的完整计划。 */
export interface FilePlan {
  files: PlannedFile[];
  source: PlanSource;
  requirement: string;
}

const VALID_SOURCES: ReadonlyArray<PlanSource> = ['local', 'cloud', 'heuristic'];

/** 是否为受支持的来源取值。 */
export function isPlanSource(value: unknown): value is PlanSource {
  return (
    typeof value === 'string' &&
    (VALID_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

/** POSIX 根路径、Windows 盘符（C:\）与 UNC 前缀都视为绝对路径。 */
const ABSOLUTE_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

/**
 * 判断相对路径是否安全可写：
 * - 去空白后非空；
 * - 不是绝对路径；
 * - 不含 `..` 越界片段。
 */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== 'string') {
    return false;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    return false;
  }
  return trimmed.split(/[\\/]+/).every((segment) => segment !== '..');
}

/** 统一为 `/` 分隔的相对路径，去掉开头的 `./` 前缀。 */
export function normaliseRelativePath(path: string): string {
  return path
    .trim()
    .replace(/\\+/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

/** 校验单个计划文件。 */
export function isPlannedFile(value: unknown): value is PlannedFile {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.path === 'string' &&
    isSafeRelativePath(record.path) &&
    typeof record.content === 'string'
  );
}

/** 校验整个文件计划（模型输出不可信，落盘前统一过一遍）。 */
export function isValidFilePlan(value: unknown): value is FilePlan {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.files) || record.files.length === 0) {
    return false;
  }
  if (typeof record.requirement !== 'string') {
    return false;
  }
  if (!isPlanSource(record.source)) {
    return false;
  }
  return record.files.every(isPlannedFile);
}