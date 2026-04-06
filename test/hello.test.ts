import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { AgentBroker } from '../src';

test('creates Fargate service', () => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const vpc = new ec2.Vpc(stack, 'Vpc');

  new AgentBroker(stack, 'AgentBroker', { vpc });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::ECS::Cluster', 1);
  template.resourceCountIs('AWS::ECS::Service', 1);
  template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
});
