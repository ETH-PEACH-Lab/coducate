import {
    AssistantMessage,
    BasePromptElementProps,
    PromptElement,
    UserMessage,
} from "@vscode/prompt-tsx";

export interface PromptProps extends BasePromptElementProps {
    note: string;
    typedText: string;
}

export interface PromptState {}

export class AutocompletePrompt extends PromptElement<
    PromptProps,
    PromptState
> {
    async render(state: PromptState) {
        return (
            <>
                <AssistantMessage>
                    You are a helpful autocompletion suggestion agent.
                    <br />
                    Your task is to provide code which does the same thing like
                    the notes from the user but it is very IMPORTANT that the
                    the suggestion starts with the already typed code from the
                    user.
                    <br />
                    Return your suggested code in plaintext.
                    <br />
                    Here is an example:
                    <br />
                    **Notes:**
                    <br />
                    print("Enter the number of people")
                    <br />
                    num_people = int(input("Number of people: "))
                    <br />
                    print("The input was: ", num_people)
                    <br />
                    **Already typed code:**
                    <br />
                    print("Provide the num of people")
                    <br />
                    num_of_people = in
                    <br />
                    **Suggestion:**
                    <br />
                    print("Provide the num of people")
                    <br />
                    num_of_people = int(input("Number of people: "))
                    <br />
                    print("The input was: ", num_people)
                    <br />
                </AssistantMessage>
                <UserMessage>
                    **Notes:**
                    <br />
                    {this.props.note}
                    <br />
                    **Already typed code:**
                    <br />
                    {this.props.typedText}
                    <br />
                    Please provide the suggestion which starts with the already
                    typed code and then follows the notes as close as possible
                    such that the code is valid. It is very IMPORTANT that the
                    code suggestion starts with the typed code.
                    <br />
                </UserMessage>
            </>
        );
    }
}
