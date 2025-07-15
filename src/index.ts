import fs, { type SymlinkType } from "fs-extra";
import * as path from "node:path";
import type Serverless from "serverless";

/** Takes a path and returns all node_modules resolution paths (but not global include paths). */
function getNodeModulePaths(p: string): string[] {
  const result: string[] = [];
  const paths = p.split(path.sep);
  while (paths.length) {
    result.push(path.join(paths.join(path.sep) || path.sep, "node_modules"));
    paths.pop();
  }
  return result;
}

/** Creates a symlink. Ignore errors if symlink exists or package exists. */
async function link(target: string, f: string, type: fs.SymlinkType) {
  await fs.ensureDir(path.dirname(f));
  // eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable
  await fs.symlink(target, f, type).catch((e: { code: string }) => {
    if (e.code) {
      if (e.code === "EEXIST" || e.code === "EISDIR") {
        return;
      }
    }
    throw e;
  });
}

interface PackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Plugin implementation */
export default class ServerlessMonoRepo {
  hooks: Record<string, () => void>;

  constructor(private serverless: Serverless) {
    this.hooks = {
      "package:cleanup": () => void this.clean(),
      "package:initialize": () => void this.initialise(),
      "before:offline:start:init": () => void this.initialise(),
      "offline:start": () => void this.initialise(),
      "deploy:function:initialize": () =>
        void (async () => {
          await this.clean();
          await this.initialise();
        })(),
    };

    // Settings
    serverless.configSchemaHandler.defineCustomProperties({
      type: "object",
      properties: {
        monorepo: {
          type: "object",
          properties: {
            path: {
              type: "string",
              default: this.serverless.config.servicePath,
            },
            linkType: {
              type: "string",
              enum: ["junction", "dir", "file"],
              default: "junction",
            },
          },
        },
      },
    });
  }

  async linkPackage(
    name: string,
    fromPath: string,
    toPath: string,
    created: Set<string>,
    resolved: string[],
  ) {
    // Ignore circular dependencies
    if (resolved.includes(name)) {
      return;
    }

    // Obtain list of module resolution paths to use for resolving modules
    const paths = getNodeModulePaths(fromPath);

    // Get package file path
    const pkg = require.resolve("./" + path.join(name, "package.json"), {
      paths,
    });

    // Get relative path to package & create link if not an embedded node_modules
    const target = path.relative(
      path.join(toPath, path.dirname(name)),
      path.dirname(pkg),
    );
    
    // Handle different package manager structures
    const isPnpmPackage = pkg.includes("/.pnpm/");
    const isBunPackage = pkg.includes("/.bun/") || pkg.includes("/bun/install/cache/");
    const shouldCreateLink = isPnpmPackage || isBunPackage
      ? true // Always create links for pnpm and bun packages to ensure compatibility
      : (pkg.match(/node_modules/g) ?? []).length <= 1;
    
    if (shouldCreateLink && !created.has(name)) {
      created.add(name);
      await link(
        target,
        path.join(toPath, name),
        this.serverless.service.custom.linkType as SymlinkType,
      );
    }

    // Get dependencies
    const packageData = (await fs.readJson(pkg)) as PackageJson;
    const { dependencies = {} } = packageData;

    // Link all dependencies
    await Promise.all(
      Object.keys(dependencies).map((dep) =>
        this.linkPackage(
          dep,
          path.dirname(pkg),
          toPath,
          created,
          resolved.concat([name]),
        ),
      ),
    );
  }

  async clean() {
    // Remove all symlinks that are of form [...]/node_modules/link
    console.log("Cleaning dependency symlinks");

    interface File {
      f: string;
      s: fs.Stats;
    }

    // Checks if a given stat result indicates a scoped package directory
    const isScopedPkgDir = (c: File) =>
      c.s.isDirectory() && c.f.startsWith("@");

    // Cleans all links in a specific path
    async function cleanAllLinks(p: string) {
      if (!(await fs.pathExists(p))) {
        return;
      }

      const files = await fs.readdir(p);
      let contents: File[] = await Promise.all(
        files.map((f) => fs.lstat(path.join(p, f)).then((s) => ({ f, s }))),
      );

      // Remove all links
      await Promise.all(
        contents
          .filter((c) => c.s.isSymbolicLink())
          .map((c) => fs.unlink(path.join(p, c.f))),
      );
      contents = contents.filter((c) => !c.s.isSymbolicLink());

      // Remove all links in scoped packages
      await Promise.all(
        contents
          .filter(isScopedPkgDir)
          .map((c) => cleanAllLinks(path.join(p, c.f))),
      );
      contents = contents.filter((c) => !isScopedPkgDir(c));

      // Remove directory if empty
      const filesInDir = await fs.readdir(p);
      if (!filesInDir.length) {
        await fs.rmdir(p);
      }
    }

    // Clean node_modules
    await cleanAllLinks(
      path.join(this.serverless.service.custom.path as string, "node_modules"),
    );
  }

  async initialise() {
    // Read package JSON
    const packageJsonPath = path.join(
      this.serverless.service.custom.path as string,
      "package.json",
    );
    const packageJson = (await fs.readJson(packageJsonPath)) as PackageJson;
    const { dependencies = {} } = packageJson;

    // Link all dependent packages
    console.log("Creating dependency symlinks");

    const contents = new Set<string>();
    await Promise.all(
      Object.keys(dependencies).map((name) =>
        this.linkPackage(
          name,
          this.serverless.service.custom.path as string,
          path.join(
            this.serverless.service.custom.path as string,
            "node_modules",
          ),
          contents,
          [],
        ),
      ),
    );
  }
}
