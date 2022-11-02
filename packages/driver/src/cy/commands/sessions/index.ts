import _ from 'lodash'
import stringifyStable from 'json-stable-stringify'

import $errUtils from '../../../cypress/error_utils'
// import $stackUtils from '../../../cypress/stack_utils'
import $utils from '../../../cypress/utils'
import logGroup from '../../logGroup'
import SessionsManager from './manager'
import {
  getConsoleProps,
  navigateAboutBlank,
} from './utils'

import type { ServerSessionData } from '@packages/types'

type SessionData = Cypress.Commands.Session.SessionData

/**
 * Session data should be cleared with spec browser launch.
 *
 * Rules for clearing session data:
 *  - if page reloads due to top navigation OR user hard reload, session data should NOT be cleared
 *  - if user relaunches the browser or launches a new spec, session data SHOULD be cleared
 *  - session data SHOULD be cleared between specs in run mode
 */
export default function (Commands, Cypress, cy) {
  // @ts-ignore

  function throwIfNoSessionSupport () {
    if (!Cypress.config('experimentalSessionAndOrigin')) {
      $errUtils.throwErrByPath('sessions.experimentNotEnabled', {
        args: {
          // determine if using experimental session opt-in flag (removed in 9.6.0) to
          // generate a coherent error message
          experimentalSessionSupport: Cypress.config('experimentalSessionSupport'),
        },
      })
    }
  }

  const sessionsManager = new SessionsManager(Cypress, cy)
  const sessions = sessionsManager.sessions

  type SESSION_STEPS = 'create' | 'restore' | 'recreate' | 'validate'
  const statusMap = {
    inProgress: (step) => {
      switch (step) {
        case 'create':
          return 'creating'
        case 'restore':
          return 'restoring'
        case 'recreate':
          return 'recreating'
        default:
          throw new Error(`${step} is not a valid session step.`)
      }
    },
    stepName: (step) => {
      switch (step) {
        case 'create':
          return 'Create new session'
        case 'restore':
          return 'Restore saved session'
        case 'recreate':
          return 'Recreate session'
        case 'validate':
          return 'Validate session'
        default:
          throw new Error(`${step} is not a valid session step.`)
      }
    },
    complete: (step) => {
      switch (step) {
        case 'create':
          return 'created'
        case 'restore':
          return 'restored'
        case 'recreate':
          return 'recreated'
        default:
          throw new Error(`${step} is not a valid session step.`)
      }
    },
  }

  Cypress.on('run:start', () => {
    // @ts-ignore
    Object.values(Cypress.state('activeSessions') || {}).forEach((sessionData: ServerSessionData) => {
      if (sessionData.cacheAcrossSpecs) {
        sessionsManager.registeredSessions.set(sessionData.id, true)
      }
    })

    Cypress.on('test:before:run:async', () => {
      if (Cypress.config('experimentalSessionAndOrigin')) {
        if (Cypress.config('testIsolation') === 'off') {
          return
        }

        // Component testing does not support navigation and handles clearing the page via mount utils
        const clearPage = Cypress.testingType === 'e2e' ? navigateAboutBlank(false) : new Cypress.Promise.resolve()

        return clearPage
        .then(() => sessions.clearCurrentSessionData())
        .then(() => Cypress.backend('reset:rendered:html:origins'))
      }

      return
    })
  })

  Commands.addAll({
    session (id: string | object, setup: () => void, options: Cypress.SessionOptions = { cacheAcrossSpecs: false }) {
      throwIfNoSessionSupport()

      if (!id || !_.isString(id) && !_.isObject(id)) {
        $errUtils.throwErrByPath('sessions.session.wrongArgId')
      }

      // stringify deterministically if we were given an object
      id = _.isString(id) ? id : stringifyStable(id)

      if (!setup || !_.isFunction(setup)) {
        $errUtils.throwErrByPath('sessions.session.wrongArgSetup')
      }

      // backup session command so we can set it as codeFrame location for errors later on
      const sessionCommand = cy.state('current')
      const withinSubject = cy.state('withinSubject')

      if (options) {
        if (!_.isObject(options)) {
          $errUtils.throwErrByPath('sessions.session.wrongArgOptions')
        }

        const validOpts = {
          'validate': 'function',
          'cacheAcrossSpecs': 'boolean',
        }

        Object.entries(options).forEach(([key, value]) => {
          const expectedType = validOpts[key]

          if (!expectedType) {
            $errUtils.throwErrByPath('sessions.session.wrongArgOptionUnexpected', { args: { key } })
          }

          const actualType = typeof value

          if (actualType !== expectedType) {
            $errUtils.throwErrByPath('sessions.session.wrongArgOptionInvalid', { args: { key, expected: expectedType, actual: actualType } })
          }
        })
      }

      let session: SessionData = sessionsManager.getActiveSession(id)
      const isRegisteredSessionForSpec = sessionsManager.registeredSessions.has(id)

      if (session) {
        const hasUniqSetupDefinition = session.setup.toString().trim() !== setup.toString().trim()
        const hasUniqValidateDefinition = (!!session.validate !== !!options.validate) || (!!session.validate && !!options.validate && session.validate.toString().trim() !== options.validate.toString().trim())
        const hasUniqPersistence = session.cacheAcrossSpecs !== !!options.cacheAcrossSpecs

        if (isRegisteredSessionForSpec && (hasUniqSetupDefinition || hasUniqValidateDefinition || hasUniqPersistence)) {
          $errUtils.throwErrByPath('sessions.session.duplicateId', {
            args: {
              id,
              hasUniqSetupDefinition,
              hasUniqValidateDefinition,
              hasUniqPersistence,
            },
          })
        }

        if (session.cacheAcrossSpecs && _.isString(session.setup)) {
          session.setup = setup
        }

        if (session.cacheAcrossSpecs && session.validate && _.isString(session.validate)) {
          session.validate = options.validate
        }
      } else {
        if (isRegisteredSessionForSpec) {
          $errUtils.throwErrByPath('sessions.session.duplicateId', { args: { id } })
        }

        session = sessions.defineSession({
          id,
          setup,
          validate: options.validate,
          cacheAcrossSpecs: options.cacheAcrossSpecs,
        })

        sessionsManager.registeredSessions.set(id, true)
      }

      function setSessionLogStatus (status: string) {
        _log.set({
          sessionInfo: {
            id: session.id,
            isGlobalSession: session.cacheAcrossSpecs,
            status,
          },
        })
      }

      function createSession (existingSession, step: 'create' | 'recreate') {
        logGroup(Cypress, {
          name: 'session',
          displayName: statusMap.stepName(step),
          message: '',
          type: 'system',

        }, (setupLogGroup) => {
          return cy.then(async () => {
            // Catch when a cypress command fails in the setup function to correctly update log status
            // before failing command and ending command queue.
            cy.state('onQueueFailed', (err, _queue) => {
              if (!_.isObject(err)) {
                err = new Error(err)
              }

              setupLogGroup.set({
                state: 'failed',
                consoleProps: () => {
                  return {
                    Step: statusMap.stepName(step),
                    Error: err?.stack || err?.message,
                  }
                },
              })

              setSessionLogStatus('failed')

              $errUtils.modifyErrMsg(err, `\n\nThis error occurred while creating the session. Because the session setup failed, we failed the test.`, _.add)

              return err
            })

            return existingSession.setup()
          })
          .then(async () => {
            cy.state('onQueueFailed', null)
            await navigateAboutBlank()
            const data = await sessions.getCurrentSessionData()

            _.extend(existingSession, data)
            existingSession.hydrated = true
            await sessions.saveSessionData(existingSession)

            _log.set({ consoleProps: () => getConsoleProps(existingSession) })
            setupLogGroup.set({
              consoleProps: () => {
                return {
                  Step: statusMap.stepName(step),
                  ...getConsoleProps(existingSession),
                }
              },
            })

            return
          })
        })
      }

      async function restoreSession (testSession) {
        Cypress.log({
          name: 'session',
          displayName: 'Restore saved session',
          message: '',
          type: 'system',
          consoleProps: () => {
            return {
              Step: 'Restore saved session',
              ...getConsoleProps(testSession),
            }
          },
        })

        _log.set({ consoleProps: () => getConsoleProps(testSession) })

        return sessions.setSessionData(testSession)
      }

      function validateSession (existingSession, step: SESSION_STEPS) {
        const isValidSession = true

        if (!existingSession.validate) {
          return isValidSession
        }

        return logGroup(Cypress, {
          name: 'session',
          displayName: 'Validate session',
          message: '',
          type: 'system',
          consoleProps: () => {
            return {
              Step: 'Validate Session',
            }
          },
        }, (validateLog) => {
          return cy.then(async () => {
            const isValidSession = true
            let caughtCommandErr = false
            let _commandToRunAfterValidation

            const enhanceErr = (err) => {
              Cypress.state('onQueueFailed', null)
              if (_.isString(err)) {
                err = new Error(err)
              }

              // show validation error and allow sessions workflow to recreate the session
              if (step === 'restore') {
                $errUtils.modifyErrMsg(err, `\n\nThis error occurred while validating the restored session. Because validation failed, we will try to recreate the session.`, _.add)

                // @ts-ignore
                err.isRecovered = true

                validateLog.set({
                  state: 'failed',
                  consoleProps: () => {
                    return {
                      Error: err.stack,
                    }
                  },
                  // explicitly set via .set() so we don't end the log group early
                  ...(!caughtCommandErr && { error: err }),
                })

                return err
              }

              setSessionLogStatus('failed')
              validateLog.set({
                state: 'failed',
                consoleProps: () => {
                  return {
                    Error: err.stack,
                  }
                },
                snapshot: true,
              })

              $errUtils.modifyErrMsg(err, `\n\nThis error occurred while validating the ${statusMap.complete(step)} session. Because validation failed immediately after ${statusMap.inProgress(step)} the session, we failed the test.`, _.add)

              return err
            }

            cy.state('onQueueFailed', (err, queue): Error => {
              if (!_.isObject(err)) {
                err = new Error(err)
              }

              if (step === 'restore') {
                const commands = queue.get()
                // determine command queue index of _commandToRunAfterValidation's index
                const index = _.findIndex(commands, (command: any) => {
                  return (
                    _commandToRunAfterValidation
                    && command.attributes.chainerId === _commandToRunAfterValidation.chainerId
                  )
                })

                // skip all commands between this command which errored and _commandToRunAfterValidation
                for (let i = cy.queue.index; i < index; i++) {
                  const cmd = commands[i]

                  if (!cmd.get('restore-within')) {
                    commands[i].skip()
                  }
                }

                // restore within subject back to the original subject used when
                // the session command kicked off
                Cypress.state('withinSubject', withinSubject)

                // move to _commandToRunAfterValidation's index to ensure failures are handled correctly
                queue.index = index

                err.isRecovered = true

                caughtCommandErr = true
              }

              return enhanceErr(err)
            })

            let returnVal

            cy.then(() => {
              returnVal = existingSession.validate.call(cy.state('ctx'))
            })

            _commandToRunAfterValidation = cy.then(async () => {
              Cypress.state('onQueueFailed', null)

              if (caughtCommandErr) {
                return !isValidSession
              }

              const failValidation = (err) => {
                if (step === 'restore') {
                  enhanceErr(err)

                  // move to recreate session flow
                  return !isValidSession
                }

                err.onFail = (err) => {
                  validateLog.error(err)
                }

                throw enhanceErr(err)
              }

              // when the validate function returns a promise, ensure it does not return false or throw an error
              if ($utils.isPromiseLike(returnVal)) {
                return returnVal
                .then((val) => {
                  if (val === false) {
                    // set current command to cy.session for more accurate codeFrame
                    cy.state('current', sessionCommand)

                    throw $errUtils.errByPath('sessions.validate_callback_false', { reason: 'promise resolved false' })
                  }

                  return isValidSession
                })
                .catch((err) => {
                  if (!(err instanceof Error)) {
                    // set current command to cy.session for more accurate codeFrame
                    cy.state('current', sessionCommand)
                    err = $errUtils.errByPath('sessions.validate_callback_false', { reason: `promise rejected with ${String(err)}` })
                  }

                  return failValidation(err)
                })
              }

              if (returnVal === undefined || Cypress.isCy(returnVal)) {
                const yielded = cy.state('current').get('prev')?.attributes?.subject

                if (yielded === false) {
                // set current command to cy.session for more accurate codeframe
                  cy.state('current', sessionCommand)

                  return failValidation($errUtils.errByPath('sessions.validate_callback_false', { reason: 'callback yielded false' }))
                }
              }

              return isValidSession
            })

            return _commandToRunAfterValidation
          })
        })
      }
      /**
       * Creates session flow:
       *   1. create session
       *   2. validate session
       */
      const createSessionWorkflow = (existingSession, step: 'create' | 'recreate') => {
        cy.then(async () => {
          setSessionLogStatus(statusMap.inProgress(step))

          await navigateAboutBlank()
          await sessions.clearCurrentSessionData()

          return createSession(existingSession, step)
        })
        .then(() => validateSession(existingSession, step))
        .then((isValidSession: boolean) => {
          if (!isValidSession) {
            throw new Error('not a valid session :(')
          }

          setSessionLogStatus(statusMap.complete(step))
        })
      }

      /**
       * Restore session flow:
       *   1. restore session
       *   2. validate session
       *   3. if validation fails, catch error and recreate session
       */
      const restoreSessionWorkflow = (existingSession) => {
        cy.then(async () => {
          setSessionLogStatus('restoring')
          await navigateAboutBlank()
          await sessions.clearCurrentSessionData()

          return restoreSession(existingSession)
        })
        .then(() => validateSession(existingSession, 'restore'))
        .then((isValidSession: boolean) => {
          if (!isValidSession) {
            return createSessionWorkflow(existingSession, 'recreate')
          }

          setSessionLogStatus('restored')
        })
      }

      /**
       * Session command rules:
       *   If session does not exists or was no previously saved to the server, create session
       *      1. run create session flow
       *      2. clear page
       *
       *   If session exists or has been saved to the server, restore session
       *      1. run restore session flow
       *      2. clear page
       */
      let _log
      const groupDetails = {
        message: `${session.id.length > 50 ? `${session.id.substring(0, 47)}...` : session.id}`,
      }

      return logGroup(Cypress, groupDetails, (log) => {
        return cy.then(async () => {
          _log = log

          if (!session.hydrated) {
            const serverStoredSession = await sessions.getSession(session.id).catch(_.noop)

            // we have a saved session on the server and setup matches
            if (serverStoredSession && serverStoredSession.setup === session.setup.toString()) {
              _.extend(session, _.omit(serverStoredSession, 'setup', 'validate'))
              session.hydrated = true
            } else {
              return createSessionWorkflow(session, 'create')
            }
          }

          return restoreSessionWorkflow(session)
        }).then(() => {
          _log.set({ state: 'passed' })
        })
      })
    },
  })

  Cypress.session = sessions
}
