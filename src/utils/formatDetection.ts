
/**
 * Detects the format of the response string.
 * @param response The response string to analyze
 * @returns 'table' | 'markdown' | 'text'
 */
export function detectResponseFormat(response: string): 'table' | 'markdown' | 'text' {
  if (!response) return 'text';

  // Check for Markdown Table
  // Looks for lines starting with | and containing | and at least one separator line like |---|
  const tableSeparatorRegex = /^\|[\s-:]*\|[\s-:]*\|/m;
  const tableRowRegex = /^\|.*\|/m;
  
  if (tableSeparatorRegex.test(response) && tableRowRegex.test(response)) {
    return 'table';
  }

  // Check for Markdown
  // Common markdown indicators: bold, italic, headers, lists, code blocks, links
  const markdownIndicators = [
    /\*\*.+\*\*/, // Bold
    /__.+__/,     // Bold/Italic
    /^#{1,6}\s/m, // Headers
    /^[-*+]\s/m,  // Unordered list
    /^\d+\.\s/m,  // Ordered list
    /`{1,3}/,     // Code
    /\[.+\]\(.+\)/ // Links
  ];

  if (markdownIndicators.some(regex => regex.test(response))) {
    return 'markdown';
  }

  return 'text';
}

