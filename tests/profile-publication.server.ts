/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';

if (Meteor.isServer) {
  describe('logged profile publication over real DDP', function () {
    it('publishes only the active account binding, never another owner or private fields', async function () {
      this.timeout(20000);
      const { Accounts } = require('meteor/accounts-base');
      const { DDP } = require('meteor/ddp-client');
      const { Random } = require('meteor/random');
      const { Mongo } = require('meteor/mongo');
      const { userprofileServerApi } = require('../imports/modules/userprofile/api/userProfileServerApi');
      const profiles = userprofileServerApi.getCollectionInstance();
      const id = `profile-ddp-${Random.id()}`;
      const profileId = `${id}-profile`;
      const other = `${id}-other`;
      const token = Accounts._generateStampedLoginToken();
      await Meteor.users.insertAsync({ _id: id, emails: [{ address: `${id}@example.test`, verified: true }] });
      await Accounts._insertLoginToken(id, token);
      await profiles.insertAsync({ _id: profileId, accountId: id, username: 'Synthetic', email: `${id}@example.test`, status: 'active', privateProbe: 'never-publish' });
      await profiles.insertAsync({ _id: other, accountId: other, username: 'Other', status: 'active' });
      const connection = DDP.connect(Meteor.absoluteUrl(), { retry: false });
      const received = new Mongo.Collection('userprofile', { connection });
      const subscribe = (...args: unknown[]) => new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Profile subscription did not become ready')), 10000);
        const handle = connection.subscribe('userprofile.getLoggedUserProfile', ...args, {
          onReady() { clearTimeout(timer); resolve(handle); },
          onStop(error: unknown) { if (error) { clearTimeout(timer); reject(error); } }
        });
      });
      try {
        const anonymous = await subscribe();
        assert.equal(await received.find().countAsync(), 0);
        anonymous.stop();
        await new Promise<void>((resolve, reject) => connection.call('login', { resume: token.token }, (error: unknown) => error ? reject(error) : resolve()));
        // A caller-supplied selector cannot redirect this dedicated self publication.
        const active = await subscribe({ _id: other });
        const docs = await received.find().fetchAsync();
        assert.equal(docs.length, 1);
        assert.equal(docs[0]._id, profileId);
        assert.equal(docs[0].accountId, id);
        assert.equal(docs[0].privateProbe, undefined);
        await profiles.updateAsync(profileId, { $set: { status: 'disabled' } });
        const deadline = Date.now() + 5000;
        while (await received.find().countAsync()) {
          assert.ok(Date.now() < deadline, 'disabled profile must be removed from the active subscription');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        active.stop();
      } finally {
        connection.close();
        await profiles.removeAsync({ _id: { $in: [profileId, other] } });
        await Meteor.users.removeAsync(id);
      }
    });
  });
}
