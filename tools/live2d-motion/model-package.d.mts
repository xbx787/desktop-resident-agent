export interface Live2DModelPackageFile {
  field: string
  path: string
}

export interface Live2DModelPackageValidation {
  errors: string[]
  files: Live2DModelPackageFile[]
}

export function validateModelPackage(modelPath: string): Live2DModelPackageValidation
