/**
 * 领域层：离线启发式规划（降级路径）。
 *
 * 纯函数，不依赖 vscode。当本地模型不可达、云端未配置或两者输出都无法解析时，
 * 直接依据需求文本推断文件名并生成有意义的骨架，保证扩展「永远能自主产出文件」。
 * 生成内容始终由 `requirement` 参与构造，不是写死的常量字符串。
 */

import type { FilePlan, PlannedFile } from './filePlan';
import { normaliseRelativePath } from './filePlan';

/** 可识别的文件扩展名，用于从需求里抽取 `*.ext` 文件名引用。 */
const KNOWN_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'md', 'markdown', 'json',
  'go', 'rs', 'java', 'cs', 'rb', 'php', 'txt', 'yaml', 'yml', 'html',
  'css', 'scss', 'sh', 'sql', 'toml', 'ini',
]);

/** 命中「目录/文件名.扩展名」的最小匹配。 */
const FILE_REFERENCE_PATTERN = /(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]+/g;

/** 关键词 → 默认文件名的推断规则，按优先级排列。 */
const KEYWORD_RULES: ReadonlyArray<{ pattern: RegExp; fileName: string }> = [
  { pattern: /python|\.py\b|脚本/i, fileName: 'main.py' },
  { pattern: /readme|说明|文档/i, fileName: 'README.md' },
  { pattern: /typescript|\bts\b/i, fileName: 'main.ts' },
  { pattern: /json|配置|config/i, fileName: 'config.json' },
];

/** 单次规划最多接受的文件数量，避免需求文本里的噪点导致文件爆炸。 */
const MAX_REFERENCED_FILES = 8;

/** 从需求里抽取带已知扩展名的文件名引用（去重、保序、限量）。 */
function extractReferencedFileNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const matches = text.match(FILE_REFERENCE_PATTERN) ?? [];
  for (const match of matches) {
    const dot = match.lastIndexOf('.');
    const extension = dot === -1 ? '' : match.slice(dot + 1).toLowerCase();
    if (!KNOWN_EXTENSIONS.has(extension)) {
      continue;
    }
    const path = normaliseRelativePath(match);
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    names.push(path);
    if (names.length >= MAX_REFERENCED_FILES) {
      break;
    }
  }
  return names;
}

/** 依据关键词推断默认文件名；无命中时回落到 notes.md。 */
function inferFileName(text: string): string {
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) {
      return rule.fileName;
    }
  }
  return 'notes.md';
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

function baseNameOf(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1] ?? path;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

/** Python 骨架：可运行的 `def main()` 入口，注释里写明需求来源。 */
function buildPython(requirement: string): string {
  return [
    '# 由 AI I/O System 依据需求自主生成',
    `# 需求来源：${requirement}`,
    '',
    '',
    'def main() -> None:',
    '    # TODO: 依据上述需求补全实现',
    '    print("AI I/O System: 骨架已生成，请按需求补全")',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n');
}

/** Markdown 骨架：标题 + 需求来源 + 要点清单。 */
function buildMarkdown(title: string, requirement: string): string {
  const heading = title.length > 0 ? title : '生成的文档';
  return [
    `# ${heading}`,
    '',
    `> 需求来源：${requirement}`,
    '',
    '## 要点',
    `- ${requirement}`,
    '',
    '## 下一步',
    '- [ ] 依据上述需求补全内容',
    '- [ ] 补充示例与验证步骤',
    '',
  ].join('\n');
}

/** JSON 骨架：合法对象，需求原文存入 requirement 字段。 */
function buildJson(requirement: string): string {
  const payload = {
    generatedBy: 'AI I/O System',
    requirement,
    items: [] as string[],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** TypeScript / JavaScript 骨架：导出入口函数。 */
function buildScript(requirement: string, language: 'ts' | 'js'): string {
  const lines = [
    '// 由 AI I/O System 依据需求自主生成',
    `// 需求来源：${requirement}`,
    '',
  ];
  if (language === 'js') {
    lines.push("'use strict';", '');
  }
  lines.push(
    'export function main(): void {',
    '  // TODO: 依据上述需求补全实现',
    '}',
    '',
    'main();',
    ''
  );
  return lines.join('\n');
}

/** 以 `#` 作注释的文本类骨架（sh / yaml / toml / ini 等）。 */
function buildHashComment(requirement: string, extension: string): string {
  return [
    '# 由 AI I/O System 依据需求自主生成',
    `# 需求来源：${requirement}`,
    `# 文件类型：.${extension}`,
    '',
  ].join('\n');
}

/** 兜底纯文本骨架，同样写明需求来源。 */
function buildPlain(requirement: string): string {
  return [
    'AI I/O System 依据需求自主生成',
    `需求来源：${requirement}`,
    '',
    'TODO: 依据上述需求补全内容。',
    '',
  ].join('\n');
}

/** 按扩展名分派到对应的内容骨架。 */
function buildContent(path: string, requirement: string): string {
  switch (extensionOf(path)) {
    case 'py':
      return buildPython(requirement);
    case 'md':
    case 'markdown':
      return buildMarkdown(baseNameOf(path), requirement);
    case 'json':
      return buildJson(requirement);
    case 'ts':
      return buildScript(requirement, 'ts');
    case 'js':
    case 'mjs':
    case 'cjs':
      return buildScript(requirement, 'js');
    case 'sh':
    case 'yml':
    case 'yaml':
    case 'toml':
    case 'ini':
      return buildHashComment(requirement, extensionOf(path));
    default:
      return buildPlain(requirement);
  }
}

/**
 * 离线降级规划：仅凭需求文本产出可落盘的文件计划。
 *
 * @param requirement 自然语言需求
 * @returns 至少包含一个文件的计划，source 固定为 `heuristic`
 */
export function planFromRequirement(requirement: string): FilePlan {
  const text = typeof requirement === 'string' ? requirement.trim() : '';
  const referenced = extractReferencedFileNames(text);
  const targets = referenced.length > 0 ? referenced : [inferFileName(text)];

  const files: PlannedFile[] = targets.map((path) => ({
    path,
    content: buildContent(path, text),
  }));

  return { files, source: 'heuristic', requirement: text };
}