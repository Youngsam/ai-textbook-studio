// Preserve code examples while accepting both common LaTeX delimiter styles.
export function normalizeMath(source: string): string {
  return source
    .split(
      /(`{3,}[^\n]*\n[\s\S]*?(?:\n`{3,}|$)|~{3,}[^\n]*\n[\s\S]*?(?:\n~{3,}|$)|`+[^`\n]*`+)/g,
    )
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(
              /\\\[([\s\S]*?)\\\]/g,
              (_, value: string) => `\n\n$$\n${value.trim()}\n$$\n\n`,
            )
            .replace(/\\\(([^\n]*?)\\\)/g, (_, value: string) => `$${value}$`),
    )
    .join("");
}
