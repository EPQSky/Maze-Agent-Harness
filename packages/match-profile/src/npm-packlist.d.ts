declare module "npm-packlist" {
  interface PackageTree {
    path: string;
    package: Record<string, unknown>;
    edgesOut: Map<unknown, unknown>;
    isProjectRoot: boolean;
  }

  export default function packlist(tree: PackageTree): Promise<string[]>;
}
