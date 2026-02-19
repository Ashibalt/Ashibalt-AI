
import { logger } from '../../logger';

/**
 * Web search using Tavily API.
 */
export async function webSearchTool(args: any): Promise<any> {
  if (!args?.query) {
    throw new Error('web_search requires "query" parameter');
  }
  
  // Get a free API key at https://tavily.com
  const apiKey = '';
  
  const query = args.query;
  const maxResults = Math.min(Math.max(1, args.max_results || 5), 10);
  
  logger.log(`[WEB_SEARCH] Searching for: "${query}", max_results: ${maxResults}`);
  
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: 'basic',
        include_answer: true,
        include_raw_content: false,
        max_results: maxResults,
        include_domains: [],
        exclude_domains: []
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.log(`[WEB_SEARCH] API error: ${response.status} - ${errorText}`);
      return {
        success: false,
        error: `Tavily API error: ${response.status} - ${errorText.slice(0, 200)}`,
        results: []
      };
    }
    
    const data: any = await response.json();
    logger.log(`[WEB_SEARCH] Got ${data.results?.length || 0} results`);
    
    // Format results for the model
    const results = (data.results || []).map((r: any) => ({
      title: r.title || 'No title',
      url: r.url,
      content: r.content || r.snippet || '',
      score: r.score
    }));
    
    // Build formatted output
    let formatted = `Web search results for: "${query}"\n\n`;
    
    // Include AI-generated answer if available
    if (data.answer) {
      formatted += `## AI Summary\n${data.answer}\n\n`;
    }
    
    formatted += `## Search Results (${results.length})\n\n`;
    
    results.forEach((r: any, i: number) => {
      formatted += `### ${i + 1}. ${r.title}\n`;
      formatted += `URL: ${r.url}\n`;
      if (r.content) {
        const content = r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content;
        formatted += `${content}\n`;
      }
      formatted += '\n';
    });
    
    return {
      success: true,
      query,
      answer: data.answer || null,
      results_count: results.length,
      results,
      formatted
    };
    
  } catch (err: any) {
    logger.log(`[WEB_SEARCH] Error: ${err.message}`);
    return {
      success: false,
      error: `Web search failed: ${err.message}`,
      results: []
    };
  }
}
