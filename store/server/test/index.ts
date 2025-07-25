/// <reference path="../../../__typings__/index.d.ts"/>
import fs from 'fs'
import path from 'path'
import getPort from 'get-port'
import { createClient } from '@pnpm/client'
import { createPackageStore } from '@pnpm/package-store'
import { connectStoreController, createServer } from '@pnpm/server'
import { type Registries } from '@pnpm/types'
import fetch from 'node-fetch'
import { sync as rimraf } from '@zkochan/rimraf'
import loadJsonFile from 'load-json-file'
import tempy from 'tempy'
import isPortReachable from 'is-port-reachable'

const registry = 'https://registry.npmjs.org/'

const registries: Registries = { default: registry }

async function createStoreController (storeDir?: string) {
  const tmp = tempy.directory()
  if (!storeDir) {
    storeDir = path.join(tmp, 'store')
  }
  const authConfig = { registry }
  const cacheDir = path.join(tmp, 'cache')
  const { resolve, fetchers, clearResolutionCache } = createClient({
    authConfig,
    cacheDir,
    rawConfig: {},
    registries,
  })
  return createPackageStore(resolve, fetchers, {
    networkConcurrency: 1,
    cacheDir,
    storeDir,
    verifyStoreIntegrity: true,
    virtualStoreDirMaxLength: 120,
    clearResolutionCache,
  })
}

test('server', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen
  const storeCtrl = await connectStoreController({ remotePrefix, concurrency: 100 })
  const projectDir = process.cwd()
  const response = await storeCtrl.requestPackage(
    { alias: 'is-positive', bareSpecifier: '1.0.0' },
    {
      downloadPriority: 0,
      lockfileDir: projectDir,
      preferredVersions: {},
      projectDir,
      sideEffectsCache: false,
    }
  )

  const { bundledManifest, files } = await response.fetching!()
  expect(bundledManifest?.name).toBe('is-positive')
  expect(response.body.id).toBe('is-positive@1.0.0')

  expect(response.body.manifest!.name).toBe('is-positive')
  expect(response.body.manifest!.version).toBe('1.0.0')

  expect(files.resolvedFrom).toBe('remote')
  expect(files.filesIndex).toHaveProperty(['package.json'])

  await server.close()
  await storeCtrl.close()
})

test('fetchPackage', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeDir = tempy.directory()
  const storeCtrlForServer = await createStoreController(storeDir)
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen
  const storeCtrl = await connectStoreController({ remotePrefix, concurrency: 100 })
  const pkgId = 'registry.npmjs.org/is-positive/1.0.0'
  // This should be fixed

  const response = await storeCtrl.fetchPackage({
    fetchRawManifest: true,
    force: false,
    lockfileDir: process.cwd(),
    pkg: {
      id: pkgId,
      resolution: {
        integrity: 'sha512-xxzPGZ4P2uN6rROUa5N9Z7zTX6ERuE0hs6GUOc/cKBLF2NqKc16UwqHMt3tFg4CO6EBTE5UecUasg+3jZx3Ckg==',
        tarball: 'https://registry.npmjs.org/is-positive/-/is-positive-1.0.0.tgz',
      },
    },
  })

  expect(typeof response.filesIndexFile).toBe('string')

  const { bundledManifest, files } = await response.fetching!()
  expect(bundledManifest).toBeTruthy()

  expect(files.resolvedFrom).toBe('remote')
  expect(files.filesIndex).toHaveProperty(['package.json'])

  await server.close()
  await storeCtrl.close()
})

test('server errors should arrive to the client', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen
  const storeCtrl = await connectStoreController({ remotePrefix, concurrency: 100 })
  let caught = false
  try {
    const projectDir = process.cwd()
    await storeCtrl.requestPackage(
      { alias: 'not-an-existing-package', bareSpecifier: '1.0.0' },
      {
        downloadPriority: 0,
        lockfileDir: projectDir,
        preferredVersions: {},
        projectDir,
        sideEffectsCache: false,
      }
    )
  } catch (e: any) { // eslint-disable-line
    caught = true
    expect(e.message).toBe('GET https://registry.npmjs.org/not-an-existing-package: Not Found - 404')
    expect(e.hint).toBe(`not-an-existing-package is not in the npm registry, or you have no permission to fetch it.

No authorization header was set for the request.`)
    expect(e.code).toBe('ERR_PNPM_FETCH_404')
    expect(e.response).toBeTruthy()
    expect(e.pkgName).toBeTruthy()
  }
  expect(caught).toBeTruthy()

  await server.close()
  await storeCtrl.close()
})

test('server upload', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeDir = tempy.directory()
  const storeCtrlForServer = await createStoreController(storeDir)
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen
  const storeCtrl = await connectStoreController({ remotePrefix, concurrency: 100 })

  const fakeEngine = 'client-engine'
  const filesIndexFile = path.join(storeDir, 'fake-pkg@1.0.0.json')

  fs.writeFileSync(filesIndexFile, JSON.stringify({
    name: 'fake-pkg',
    version: '1.0.0',
    files: {},
  }), 'utf8')

  await storeCtrl.upload(path.join(__dirname, '__fixtures__/side-effect-fake-dir'), {
    sideEffectsCacheKey: fakeEngine,
    filesIndexFile,
  })

  const cacheIntegrity = loadJsonFile.sync<any>(filesIndexFile) // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(Object.keys(cacheIntegrity?.['sideEffects'][fakeEngine].added).sort()).toStrictEqual(['side-effect.js', 'side-effect.txt'])

  await server.close()
  await storeCtrl.close()
})

test('disable server upload', async () => {
  rimraf('.store')

  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    ignoreUploadRequests: true,
    port,
  })
  await server.waitForListen
  const storeCtrl = await connectStoreController({ remotePrefix, concurrency: 100 })

  const fakeEngine = 'client-engine'
  const storeDir = tempy.directory()
  const filesIndexFile = path.join(storeDir, 'test.example.com/fake-pkg/1.0.0.json')

  let thrown = false
  try {
    await storeCtrl.upload(path.join(__dirname, '__fixtures__/side-effect-fake-dir'), {
      sideEffectsCacheKey: fakeEngine,
      filesIndexFile,
    })
  } catch {
    thrown = true
  }
  expect(thrown).toBeTruthy()

  expect(fs.existsSync(filesIndexFile)).toBeFalsy()

  await server.close()
  await storeCtrl.close()
})

test('stop server with remote call', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    ignoreStopRequests: false,
    port,
  })
  await server.waitForListen

  expect(await isPortReachable(port)).toBeTruthy()

  const response = await fetch(`${remotePrefix}/stop`, { method: 'POST' })

  expect(response.status).toBe(200)

  expect(await isPortReachable(port)).toBeFalsy()
})

test('disallow stop server with remote call', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    ignoreStopRequests: true,
    port,
  })
  await server.waitForListen

  expect(await isPortReachable(port)).toBeTruthy()

  const response = await fetch(`${remotePrefix}/stop`, { method: 'POST' })
  expect(response.status).toBe(403)

  expect(await isPortReachable(port)).toBeTruthy()

  await server.close()
})

test('disallow store prune', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen

  expect(await isPortReachable(port)).toBeTruthy()

  const response = await fetch(`${remotePrefix}/prune`, { method: 'POST' })
  expect(response.status).toBe(403)

  await server.close()
  await storeCtrlForServer.close()
})

test('server should only allow POST', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen

  expect(await isPortReachable(port)).toBeTruthy()

  // Try various methods (not including POST)
  const methods = ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

  /* eslint-disable no-await-in-loop */
  for (const method of methods) {
    // Ensure 405 error is received
    const response = await fetch(`${remotePrefix}/a-random-endpoint`, { method })
    expect(response.status).toBe(405)
    expect((await response.json() as any).error).toBeTruthy() // eslint-disable-line
  }
  /* eslint-enable no-await-in-loop */

  await server.close()
  await storeCtrlForServer.close()
})

test('server route not found', async () => {
  const port = await getPort()
  const hostname = 'localhost'
  const remotePrefix = `http://${hostname}:${port}`
  const storeCtrlForServer = await createStoreController()
  const server = createServer(storeCtrlForServer, {
    hostname,
    port,
  })
  await server.waitForListen

  expect(await isPortReachable(port)).toBeTruthy()

  // Ensure 404 error is received
  const response = await fetch(`${remotePrefix}/a-random-endpoint`, { method: 'POST' })
  // Ensure error is correct
  expect(response.status).toBe(404)
  expect((await response.json() as any).error).toBeTruthy() // eslint-disable-line

  await server.close()
  await storeCtrlForServer.close()
})
