import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private resumeContext: string = '';
  private projectContext: string = '';
  private contextDir: string;

  constructor() {
    this.contextDir = path.join(process.cwd(), 'context');
    this.loadContextFiles();
  }

  /**
   * Load resume and project files from the context directory.
   */
  private loadContextFiles(): void {
    try {
      if (!fs.existsSync(this.contextDir)) {
        fs.mkdirSync(this.contextDir, { recursive: true });
        this.logger.log(`Created context directory: ${this.contextDir}`);

        // Create sample files
        this.createSampleFiles();
        return;
      }

      // Load resume
      const resumePath = path.join(this.contextDir, 'resume.json');
      if (fs.existsSync(resumePath)) {
        const data = fs.readFileSync(resumePath, 'utf-8');
        this.resumeContext = data;
        this.logger.log('Resume loaded from context/resume.json');
      }

      // Load project details
      const projectPath = path.join(this.contextDir, 'projects.json');
      if (fs.existsSync(projectPath)) {
        const data = fs.readFileSync(projectPath, 'utf-8');
        this.projectContext = data;
        this.logger.log('Projects loaded from context/projects.json');
      }

      // Load any additional .txt files
      const files = fs
        .readdirSync(this.contextDir)
        .filter((f) => f.endsWith('.txt'));
      for (const file of files) {
        const content = fs.readFileSync(
          path.join(this.contextDir, file),
          'utf-8',
        );
        this.projectContext += `\n\n--- ${file} ---\n${content}`;
      }
    } catch (err: any) {
      this.logger.error(`Failed to load context files: ${err.message}`);
    }
  }

  private createSampleFiles(): void {
    const sampleResume = {
      name: 'Your Name',
      title: 'Full Stack MERN Developer',
      experience: [
        {
          company: 'Company Name',
          role: 'Full Stack Developer',
          duration: '2023 - Present',
          highlights: [
            'Built scalable REST APIs with Node.js and Express',
            'Developed React frontends with TypeScript',
            'Managed MongoDB databases and Redis caching',
          ],
        },
      ],
      skills: {
        frontend: ['React', 'Next.js', 'TypeScript', 'HTML/CSS'],
        backend: ['Node.js', 'Express', 'NestJS', 'REST APIs'],
        database: ['MongoDB', 'PostgreSQL', 'Redis'],
        tools: ['Git', 'Docker', 'AWS', 'CI/CD'],
      },
      education: 'Your Education',
    };

    fs.writeFileSync(
      path.join(this.contextDir, 'resume.json'),
      JSON.stringify(sampleResume, null, 2),
    );

    const sampleProjects = {
      projects: [
        {
          name: 'E-Commerce Platform',
          description: 'Full-stack e-commerce application',
          tech: ['React', 'Node.js', 'MongoDB', 'Stripe'],
          highlights: [
            'Payment integration',
            'Order management',
            'Admin dashboard',
          ],
        },
      ],
    };

    fs.writeFileSync(
      path.join(this.contextDir, 'projects.json'),
      JSON.stringify(sampleProjects, null, 2),
    );

    this.logger.log('Created sample context files in context/ directory');
  }

  /**
   * Get the combined context for the AI prompt.
   */
  getContext(): string {
    let context = '';
    if (this.resumeContext) {
      context += `RESUME:\n${this.resumeContext}\n\n`;
    }
    if (this.projectContext) {
      context += `PROJECT DETAILS:\n${this.projectContext}`;
    }
    return context || 'No resume or project context provided.';
  }

  /**
   * Update resume context at runtime (from file upload).
   */
  updateResumeContext(content: string): void {
    this.resumeContext = content;
    this.logger.log('Resume context updated at runtime');
  }

  /**
   * Reload context from disk.
   */
  reloadContext(): void {
    this.loadContextFiles();
    this.logger.log('Context reloaded from disk');
  }
}
