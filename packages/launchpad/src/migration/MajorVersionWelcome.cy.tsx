import { defaultMessages } from '@cy/i18n'
import MajorVersionWelcome from './MajorVersionWelcome.vue'
import interval from 'human-interval'

const text = defaultMessages.majorVersionWelcome

describe('<MajorVersionWelcome />', { viewportWidth: 1280, viewportHeight: 1400 }, () => {
  it('renders expected interactive content', () => {
    const continueStub = cy.stub()

    cy.mount(<MajorVersionWelcome onClearLandingPage={continueStub} />)

    cy.contains('h1', 'What\'s New in Cypress').should('be.visible')
    cy.contains('a[href="https://on.cypress.io/changelog"]', text.linkReleaseNotes).should('be.visible')
    cy.contains('a[href="https://on.cypress.io/changelog#11-0-0"]', '11.0.0').should('be.visible')
    cy.contains('a[href="https://on.cypress.io/changelog#10-0-0"]', '10.0.0').should('be.visible')

    cy.contains('button', text.actionContinue).should('be.visible')
    cy.contains('button', text.actionContinue).click()
    cy.wrap(continueStub).should('have.been.calledOnce')
  })

  it('renders correct time for releases and overflows correctly', () => {
    cy.clock(Date.UTC(2022, 11, 8))
    cy.mount(<MajorVersionWelcome />)
    cy.contains('11.0.0 Released just now')
    cy.contains('10.0.0 Released 5 months ago')
    cy.tick(interval('1 minute'))
    cy.contains('11.0.0 Released 1 minute ago')
    cy.tick(interval('1 month'))
    cy.contains('11.0.0 Released last month')
    cy.contains('10.0.0 Released 6 months ago')

    // doing these here since cy.clock will keep text content static
    // for percy
    cy.percySnapshot('looks good at full size')

    cy.viewport(1280, 500)

    cy.percySnapshot('content overflows inside box')
  })
})
