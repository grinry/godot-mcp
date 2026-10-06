export interface Diagnostic {
  file: string | null;
  line: number | null;
  severity: 'error' | 'warning';
  message: string;
}

/** Godot emits the source location on either the headline or a following stack frame. */
export function parseDiagnostics(lines: string[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  let current: Diagnostic | undefined;
  for (const raw of lines) {
    const text = raw.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').trim();
    const headline =
      /^(?:SCRIPT ERROR|ERROR|Error|Parse Error|WARNING|Warning|Failed to)\s*:?\s*(.*)/.exec(text);
    if (headline) {
      current = {
        file: null,
        line: null,
        severity: /^(WARNING|Warning)/.test(text) ? 'warning' : 'error',
        message: headline[1] || text,
      };
      result.push(current);
    }
    const location =
      /(?:^|[\s(])((?:res:\/\/|[A-Za-z]:[\\/]|\/)[^\n]*?):(\d+)(?:\)?(?:\s|$)|:)/.exec(text);
    if (
      current &&
      current.file === null &&
      location &&
      (headline || /^(?:at:|\[\d+\])/.test(text))
    ) {
      current.file = location[1];
      current.line = Number(location[2]);
    }
  }
  return result;
}

export function diagnosticCounts(diagnostics: Diagnostic[]) {
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
  };
}
