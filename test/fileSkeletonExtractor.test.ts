import { describe, it, expect } from 'vitest';
import { 
  extractSkeleton, 
  formatSkeletonCompact,
  detectLanguage 
} from '../src/Engine/SystemContext/fileSkeletonExtractor';

describe('fileSkeletonExtractor', () => {
  
  describe('detectLanguage', () => {
    it('should detect TypeScript', () => {
      expect(detectLanguage('file.ts')).toBe('typescript');
      expect(detectLanguage('component.tsx')).toBe('typescript');
    });
    
    it('should detect JavaScript', () => {
      expect(detectLanguage('file.js')).toBe('javascript');
      expect(detectLanguage('component.jsx')).toBe('javascript');
      expect(detectLanguage('module.mjs')).toBe('javascript');
    });
    
    it('should detect Python', () => {
      expect(detectLanguage('script.py')).toBe('python');
      expect(detectLanguage('gui.pyw')).toBe('python');
    });
    
    it('should return unknown for unsupported extensions', () => {
      expect(detectLanguage('file.xyz')).toBe('unknown');
      expect(detectLanguage('noextension')).toBe('unknown');
    });
  });
  
  describe('extractSkeleton - TypeScript', () => {
    
    it('should extract imports', () => {
      const code = `import { foo } from 'bar';
import * as vscode from 'vscode';

const x = 1;`;
      
      const skeleton = extractSkeleton(code, 'test.ts');
      
      expect(skeleton.language).toBe('typescript');
      expect(skeleton.totalLines).toBe(4);
      expect(skeleton.items.some(i => i.type === 'import')).toBe(true);
    });
    
    it('should extract classes with methods', () => {
      const code = `import { x } from 'y';

export class MyClass {
  private field: string;
  
  constructor() {
    this.field = '';
  }
  
  public doSomething(): void {
    console.log('hello');
  }
  
  private helper(): string {
    return this.field;
  }
}`;
      
      const skeleton = extractSkeleton(code, 'test.ts');
      
      const classItem = skeleton.items.find(i => i.type === 'class');
      expect(classItem).toBeDefined();
      expect(classItem?.name).toBe('MyClass');
      expect(classItem?.children?.length).toBeGreaterThan(0);
      expect(classItem?.children?.some(c => c.name === 'constructor')).toBe(true);
      expect(classItem?.children?.some(c => c.name === 'doSomething')).toBe(true);
    });
    
    it('should extract functions', () => {
      const code = `function regularFunction(a: number): string {
  return String(a);
}

export async function asyncFunc(): Promise<void> {
  await something();
}

const arrowFunc = (x: number) => x * 2;

export const exportedArrow = async () => {
  return true;
};`;
      
      const skeleton = extractSkeleton(code, 'test.ts');
      
      const functions = skeleton.items.filter(i => i.type === 'function');
      expect(functions.length).toBeGreaterThanOrEqual(2);
      expect(functions.some(f => f.name === 'regularFunction')).toBe(true);
      expect(functions.some(f => f.name === 'asyncFunc')).toBe(true);
    });
    
    it('should extract interfaces and types', () => {
      const code = `export interface User {
  name: string;
  age: number;
}

type Status = 'active' | 'inactive';

export type Handler = (event: Event) => void;

interface Internal {
  id: string;
}`;
      
      const skeleton = extractSkeleton(code, 'test.ts');
      
      const interfaces = skeleton.items.filter(i => i.type === 'interface');
      const types = skeleton.items.filter(i => i.type === 'type');
      
      expect(interfaces.some(i => i.name === 'User')).toBe(true);
      expect(types.some(t => t.name === 'Status')).toBe(true);
      expect(types.some(t => t.name === 'Handler')).toBe(true);
    });
  });
  
  describe('extractSkeleton - Python', () => {
    
    it('should extract imports', () => {
      const code = `import os
from typing import List, Optional
from pathlib import Path

def main():
    pass`;
      
      const skeleton = extractSkeleton(code, 'script.py');
      
      expect(skeleton.language).toBe('python');
      expect(skeleton.items.some(i => i.type === 'import')).toBe(true);
    });
    
    it('should extract classes with methods', () => {
      const code = `class MyClass:
    def __init__(self, name: str):
        self.name = name
    
    def greet(self) -> str:
        return f"Hello, {self.name}"
    
    async def async_method(self):
        await something()

class AnotherClass(BaseClass):
    def method(self):
        pass`;
      
      const skeleton = extractSkeleton(code, 'script.py');
      
      const classes = skeleton.items.filter(i => i.type === 'class');
      expect(classes.length).toBe(2);
      expect(classes[0].name).toBe('MyClass');
      expect(classes[0].children?.some(c => c.name === '__init__')).toBe(true);
      expect(classes[0].children?.some(c => c.name === 'greet')).toBe(true);
    });
    
    it('should extract functions', () => {
      const code = `def regular_function(a: int) -> str:
    return str(a)

async def async_function():
    await something()

def another():
    pass`;
      
      const skeleton = extractSkeleton(code, 'script.py');
      
      const functions = skeleton.items.filter(i => i.type === 'function');
      expect(functions.length).toBe(3);
      expect(functions.some(f => f.name === 'regular_function')).toBe(true);
      expect(functions.some(f => f.name === 'async_function')).toBe(true);
    });
  });
  
  describe('formatSkeletonCompact', () => {
    
    it('should format skeleton compactly', () => {
      const code = `import { x } from 'y';

export class Example {
  method() {}
}

function helper() {}`;
      
      const skeleton = extractSkeleton(code, 'test.ts');
      const formatted = formatSkeletonCompact(skeleton);
      
      expect(formatted).toContain('[test.ts]');
      expect(formatted).toContain('classes:');
      expect(formatted).toContain('Example');
      expect(formatted).toContain('fn:');
      expect(formatted).toContain('helper');
    });
    
    it('should be significantly shorter than original content', () => {
      const code = `import { a, b, c, d } from 'module';
import { e, f } from 'another';

export class UserService {
  private db: Database;
  
  constructor(db: Database) {
    this.db = db;
  }
  
  async getUser(id: string): Promise<User | null> {
    const result = await this.db.query('SELECT * FROM users WHERE id = ?', [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToUser(result.rows[0]);
  }
  
  async createUser(data: CreateUserDto): Promise<User> {
    const id = generateId();
    await this.db.query('INSERT INTO users ...', [id, data.name, data.email]);
    return { id, ...data };
  }
  
  private mapRowToUser(row: any): User {
    return { id: row.id, name: row.name, email: row.email };
  }
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface CreateUserDto {
  name: string;
  email: string;
}`;
      
      const skeleton = extractSkeleton(code, 'userService.ts');
      const compact = formatSkeletonCompact(skeleton);
      
      // Compact format should be much shorter
      expect(compact.length).toBeLessThan(code.length * 0.5);
    });
  });
});
