export function validateTerraform(name: string,args: unknown,knownIds: Set<string>): void;
export function validateStorybook(name: string,args: unknown,knownStories: Set<string>,component: string): void;
export function validatePreviewUrl(value: string,port: number,knownStories: Set<string>): URL;
