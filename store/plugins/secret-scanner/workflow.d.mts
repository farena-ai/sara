export const labels: Record<string,{title:string;description:string;scope:string;error:string;summary:string;message:string}>;
export const parameters: any;
export function handle(args: any,lang?: string): Promise<{content:string;card:{title:string;lines:string[]}}>;
