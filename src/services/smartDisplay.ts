/**
 * Smart Display Service for Intelligent Data Presentation
 * Analyzes data structure and determines optimal display format
 */

export type DisplayType = 
  | 'text'
  | 'product_card'
  | 'comparison_table'
  | 'pricing_table'
  | 'feature_list'
  | 'technical_spec'
  | 'faq'
  | 'timeline'
  | 'code_snippet';

export interface DisplayFormat {
  type: DisplayType;
  data: any;
  metadata?: {
    columns?: string[];
    highlighted?: string[];
    sortBy?: string;
    groupBy?: string;
    layout?: 'grid' | 'list' | 'carousel';
  };
}

export interface DataAnalysis {
  dataType: string;
  structure: 'flat' | 'nested' | 'tabular' | 'mixed';
  keyFields: string[];
  numericFields: string[];
  hasPrice: boolean;
  hasSpecs: boolean;
  hasComparison: boolean;
  recordCount: number;
}

export class SmartDisplayService {
  /**
   * Analyze sources and determine the best display format
   */
  analyze(sources: any[], query?: string): DisplayFormat {
    if (!sources || sources.length === 0) {
      return { type: 'text', data: null };
    }

    // Analyze the data structure
    const analysis = this.analyzeDataStructure(sources);
    
    // Determine display type based on analysis and query intent
    const displayType = this.determineDisplayType(analysis, query);
    
    // Format data according to display type
    const formattedData = this.formatData(sources, displayType, analysis);
    
    return formattedData;
  }

  private analyzeDataStructure(sources: any[]): DataAnalysis {
    const analysis: DataAnalysis = {
      dataType: 'unknown',
      structure: 'flat',
      keyFields: [],
      numericFields: [],
      hasPrice: false,
      hasSpecs: false,
      hasComparison: false,
      recordCount: sources.length
    };

    // Analyze first few sources to understand structure
    const sampleSize = Math.min(5, sources.length);
    const samples = sources.slice(0, sampleSize);

    // Check for common patterns
    for (const source of samples) {
      const content = source.content?.toLowerCase() || '';
      const metadata = source.metadata || {};

      // Price detection
      if (content.match(/\$[\d,]+\.?\d*|price|cost|pricing|fee/i)) {
        analysis.hasPrice = true;
      }

      // Specification detection
      if (content.match(/specifications?|specs?|dimensions?|weight|size|capacity/i)) {
        analysis.hasSpecs = true;
      }

      // Comparison detection
      if (content.match(/vs\.?|versus|compared to|comparison|alternative/i)) {
        analysis.hasComparison = true;
      }

      // Extract fields from metadata
      if (metadata && typeof metadata === 'object') {
        Object.keys(metadata).forEach(key => {
          if (!analysis.keyFields.includes(key)) {
            analysis.keyFields.push(key);
          }
          
          const value = metadata[key];
          if (typeof value === 'number' && !analysis.numericFields.includes(key)) {
            analysis.numericFields.push(key);
          }
        });
      }
    }

    // Determine structure type
    if (analysis.keyFields.length > 5 && analysis.numericFields.length > 2) {
      analysis.structure = 'tabular';
    } else if (analysis.keyFields.some(f => f.includes('.') || f.includes('_'))) {
      analysis.structure = 'nested';
    }

    // Determine data type
    if (analysis.hasPrice && analysis.hasComparison) {
      analysis.dataType = 'pricing_comparison';
    } else if (analysis.hasPrice) {
      analysis.dataType = 'pricing';
    } else if (analysis.hasSpecs) {
      analysis.dataType = 'technical';
    } else if (sources.some(s => s.metadata?.type === 'product')) {
      analysis.dataType = 'product';
    } else if (sources.some(s => s.content?.includes('?'))) {
      analysis.dataType = 'faq';
    }

    return analysis;
  }

  private determineDisplayType(analysis: DataAnalysis, query?: string): DisplayType {
    const queryLower = query?.toLowerCase() || '';

    // Query-based determination
    if (queryLower.includes('compar') || queryLower.includes('vs') || queryLower.includes('difference')) {
      return analysis.structure === 'tabular' ? 'comparison_table' : 'feature_list';
    }

    if (queryLower.includes('pric') || queryLower.includes('cost') || queryLower.includes('plan')) {
      return 'pricing_table';
    }

    if (queryLower.includes('spec') || queryLower.includes('technical') || queryLower.includes('dimension')) {
      return 'technical_spec';
    }

    if (queryLower.includes('how') || queryLower.includes('when') || queryLower.includes('timeline')) {
      return 'timeline';
    }

    // Data-based determination
    switch (analysis.dataType) {
      case 'pricing_comparison':
        return 'comparison_table';
      case 'pricing':
        return 'pricing_table';
      case 'technical':
        return 'technical_spec';
      case 'product':
        return analysis.recordCount > 1 ? 'product_card' : 'technical_spec';
      case 'faq':
        return 'faq';
      default:
        return analysis.structure === 'tabular' && analysis.recordCount > 2 
          ? 'comparison_table' 
          : 'text';
    }
  }

  private formatData(
    sources: any[], 
    displayType: DisplayType, 
    analysis: DataAnalysis
  ): DisplayFormat {
    switch (displayType) {
      case 'product_card':
        return this.formatAsProductCards(sources);
      
      case 'comparison_table':
        return this.formatAsComparisonTable(sources, analysis);
      
      case 'pricing_table':
        return this.formatAsPricingTable(sources);
      
      case 'technical_spec':
        return this.formatAsTechnicalSpec(sources);
      
      case 'feature_list':
        return this.formatAsFeatureList(sources);
      
      case 'faq':
        return this.formatAsFAQ(sources);
      
      case 'timeline':
        return this.formatAsTimeline(sources);
      
      case 'code_snippet':
        return this.formatAsCodeSnippet(sources);
      
      default:
        return { type: 'text', data: sources };
    }
  }

  private formatAsProductCards(sources: any[]): DisplayFormat {
    const cards = sources.map(source => {
      const metadata = source.metadata || {};
      return {
        id: source.documentId,
        title: metadata.title || source.filename,
        description: this.extractDescription(source.content),
        price: this.extractPrice(source.content),
        features: this.extractFeatures(source.content),
        image: metadata.image,
        url: source.sourceUrl
      };
    });

    return {
      type: 'product_card',
      data: cards,
      metadata: {
        layout: 'grid'
      }
    };
  }

  private formatAsComparisonTable(sources: any[], analysis: DataAnalysis): DisplayFormat {
    // Extract comparison data
    const items = sources.map(source => {
      const data: any = {
        name: source.metadata?.name || source.filename,
        source: source.sourceUrl
      };

      // Extract key fields
      analysis.keyFields.forEach(field => {
        if (source.metadata?.[field]) {
          data[field] = source.metadata[field];
        }
      });

      // Extract from content if needed
      if (analysis.hasPrice) {
        data.price = this.extractPrice(source.content);
      }

      return data;
    });

    const columns = ['name', ...analysis.keyFields, 'price'].filter(Boolean);

    return {
      type: 'comparison_table',
      data: items,
      metadata: {
        columns,
        highlighted: analysis.numericFields
      }
    };
  }

  private formatAsPricingTable(sources: any[]): DisplayFormat {
    const plans = sources.map(source => {
      const content = source.content || '';
      return {
        name: source.metadata?.planName || this.extractPlanName(content),
        price: this.extractPrice(content),
        features: this.extractFeatures(content),
        highlighted: source.metadata?.recommended || false,
        cta: source.metadata?.cta || 'Get Started'
      };
    });

    return {
      type: 'pricing_table',
      data: plans,
      metadata: {
        layout: 'grid'
      }
    };
  }

  private formatAsTechnicalSpec(sources: any[]): DisplayFormat {
    const specs: any = {};

    sources.forEach(source => {
      const content = source.content || '';
      const extracted = this.extractSpecifications(content);
      
      Object.entries(extracted).forEach(([key, value]) => {
        if (!specs[key]) {
          specs[key] = value;
        }
      });
    });

    return {
      type: 'technical_spec',
      data: specs
    };
  }

  private formatAsFeatureList(sources: any[]): DisplayFormat {
    const features: any[] = [];

    sources.forEach(source => {
      const extracted = this.extractFeatures(source.content);
      extracted.forEach(feature => {
        if (!features.find(f => f.title === feature)) {
          features.push({
            title: feature,
            description: this.extractFeatureDescription(source.content, feature),
            category: source.metadata?.category
          });
        }
      });
    });

    return {
      type: 'feature_list',
      data: features,
      metadata: {
        groupBy: 'category'
      }
    };
  }

  private formatAsFAQ(sources: any[]): DisplayFormat {
    const faqs = sources.map(source => {
      const content = source.content || '';
      const qa = this.extractQA(content);
      return {
        question: qa.question || source.metadata?.question,
        answer: qa.answer || content,
        category: source.metadata?.category
      };
    }).filter(faq => faq.question);

    return {
      type: 'faq',
      data: faqs
    };
  }

  private formatAsTimeline(sources: any[]): DisplayFormat {
    const events = sources.map(source => ({
      date: source.metadata?.date || this.extractDate(source.content),
      title: source.metadata?.title || this.extractTitle(source.content),
      description: this.extractDescription(source.content)
    })).filter(event => event.date)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return {
      type: 'timeline',
      data: events
    };
  }

  private formatAsCodeSnippet(sources: any[]): DisplayFormat {
    const snippets = sources.map(source => ({
      language: source.metadata?.language || 'javascript',
      code: this.extractCode(source.content),
      title: source.metadata?.title,
      description: source.metadata?.description
    }));

    return {
      type: 'code_snippet',
      data: snippets
    };
  }

  // Extraction helper methods
  private extractPrice(content: string): string | null {
    const priceMatch = content.match(/\$[\d,]+\.?\d*/);
    return priceMatch ? priceMatch[0] : null;
  }

  private extractFeatures(content: string): string[] {
    const features: string[] = [];
    const lines = content.split('\n');
    
    lines.forEach(line => {
      if (line.match(/^[\s]*[-•*]\s+(.+)$/)) {
        features.push(RegExp.$1.trim());
      }
    });

    return features;
  }

  private extractDescription(content: string): string {
    const firstParagraph = content.split('\n\n')[0];
    return firstParagraph.length > 200 
      ? firstParagraph.substring(0, 197) + '...'
      : firstParagraph;
  }

  private extractSpecifications(content: string): Record<string, any> {
    const specs: Record<string, any> = {};
    const lines = content.split('\n');

    lines.forEach(line => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        specs[match[1].trim()] = match[2].trim();
      }
    });

    return specs;
  }

  private extractPlanName(content: string): string {
    const match = content.match(/^#\s+(.+)$|^##\s+(.+)$/m);
    return match ? (match[1] || match[2]).trim() : 'Plan';
  }

  private extractFeatureDescription(content: string, feature: string): string {
    const index = content.indexOf(feature);
    if (index === -1) return '';
    
    const afterFeature = content.substring(index + feature.length);
    const nextLineBreak = afterFeature.indexOf('\n');
    
    return nextLineBreak > 0 
      ? afterFeature.substring(0, Math.min(nextLineBreak, 100)).trim()
      : '';
  }

  private extractQA(content: string): { question?: string; answer?: string } {
    const questionMatch = content.match(/^(?:Q:|Question:)\s*(.+)$/mi);
    const answerMatch = content.match(/^(?:A:|Answer:)\s*(.+)$/mi);
    
    return {
      question: questionMatch ? questionMatch[1].trim() : undefined,
      answer: answerMatch ? answerMatch[1].trim() : undefined
    };
  }

  private extractDate(content: string): string | null {
    const dateMatch = content.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/);
    return dateMatch ? dateMatch[0] : null;
  }

  private extractTitle(content: string): string {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : content.split('\n')[0].substring(0, 50);
  }

  private extractCode(content: string): string {
    const codeMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
    return codeMatch ? codeMatch[1].trim() : content;
  }
}

export const smartDisplayService = new SmartDisplayService();