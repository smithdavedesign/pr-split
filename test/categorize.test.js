import { describe, expect, it } from 'vitest';
import { GROUPS, categorize, heuristicGroups } from '../src/categorize.js';
import { API_FILES, DB_FILES } from './helpers.js';

const file = (path, extra = {}) => ({ path, status: 'A', additions: 1, deletions: 0, binary: false, ...extra });

describe('categorize', () => {
  it.each([
    ['db/migrations/001_users.sql', 'database'],
    ['prisma/schema.prisma', 'database'],
    ['src/models/user.ts', 'database'],
    ['queries/report.sql', 'database'],
    ['DB/Schema.SQL', 'database'],
    ['src/api/users.ts', 'api'],
    ['app/api/orders/route.ts', 'api'],
    ['server/index.js', 'api'],
    ['src/middleware/auth.js', 'api'],
    ['src/components/Button.tsx', 'ui'],
    ['styles/main.css', 'ui'],
    ['src/App.vue', 'ui'],
    ['src/api/users.test.ts', 'api'],
    ['tests/helpers.js', 'tests'],
    ['src/utils/date.spec.js', 'tests'],
    ['pkg/handler_test.go', 'tests'],
    ['test_models.py', 'tests'],
    ['docs/api/reference.md', 'docs'],
    ['CHANGELOG.md', 'docs'],
    ['package.json', 'config'],
    ['package-lock.json', 'config'],
    ['.github/workflows/ci.yml', 'config'],
    ['Dockerfile', 'config'],
    ['vite.config.ts', 'config'],
    ['tsconfig.json', 'config'],
    ['src/utils/date.js', 'shared'],
    ['lib/index.js', 'shared'],
  ])('%s → %s', (path, group) => {
    expect(categorize(path)).toBe(group);
  });
});

describe('heuristicGroups', () => {
  it('splits the 5 database + 5 API fixture into exactly database then api', () => {
    const files = [...Object.keys(API_FILES), ...Object.keys(DB_FILES)].sort().map((p) => file(p));
    const groups = heuristicGroups(files);
    expect(groups.map((g) => g.name)).toEqual(['database', 'api']);
    expect(groups[0].files.map((f) => f.path).sort()).toEqual(Object.keys(DB_FILES).sort());
    expect(groups[1].files.map((f) => f.path).sort()).toEqual(Object.keys(API_FILES).sort());
  });

  it('orders groups so dependencies come first and drops empty ones', () => {
    const groups = heuristicGroups(
      ['README.md', 'src/components/A.tsx', 'package.json', 'tests/e2e.js', 'src/api/a.js', 'lib/util.js', 'db/a.sql'].map((p) =>
        file(p),
      ),
    );
    expect(groups.map((g) => g.name)).toEqual(['config', 'shared', 'database', 'api', 'ui', 'tests', 'docs']);
    expect(GROUPS.map((g) => g.name)).toEqual(['config', 'shared', 'database', 'api', 'ui', 'tests', 'docs']);
    expect(heuristicGroups([file('src/api/a.js')]).map((g) => g.name)).toEqual(['api']);
  });

  it('keeps the diff order inside a group and gives every group a description', () => {
    const files = [file('src/api/b.js'), file('src/api/a.js')];
    const [api] = heuristicGroups(files);
    expect(api.files).toEqual(files);
    expect(api.description).toMatch(/\w/);
  });

  it('categorizes a renamed file by its new path', () => {
    const [group] = heuristicGroups([file('db/users.sql', { status: 'R', oldPath: 'src/api/users.sql.txt' })]);
    expect(group.name).toBe('database');
  });
});
